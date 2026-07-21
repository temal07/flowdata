/**
 * engine.ts — the static-analysis core of flowdata.
 *
 * This module walks a TypeScript/JavaScript AST (as produced by
 * `@typescript-eslint/typescript-estree`) exactly once and, for a single
 * file, produces a `Results` object: a flat list of `Binding`s (every
 * declaration in the file — variables, functions, params, classes, types,
 * imports, catch params) each carrying the `Use`s (references) that were
 * found for it during the walk.
 *
 * `flow.ts` (the CLI) calls `collectVariables` once per file in a project,
 * stitches the per-file `Results` together (resolving imports to the real
 * declaration they point at), and turns the result into a dependency graph.
 *
 * ## The scope stack
 * `walkVariables` carries a `Scope[]` stack through the recursion. Each
 * scope holds the declarations introduced at that level (global, function
 * body, or block) so that two variables with the same name in different
 * scopes don't collide — an `Identifier` reference resolves by searching
 * the stack from the innermost scope outward and binding to the first
 * declaration with a matching name (normal lexical shadowing).
 *
 * ## The "feeds" mechanism
 * Beyond plain declaration/use tracking, this engine also records *data
 * flow*: which declaration a use's value ultimately flows into. This is
 * exposed as `Use.feeds`, a pointer at the fed declaration's `{file,
 * start}` identity (a stable node id — see `nodeId` in flow.ts).
 *
 * Rather than threading a "current flow target" argument through every
 * recursive call, the walker keeps it in a module-level variable,
 * `currentFeedTarget`. Whenever the walker is about to descend into a
 * subtree whose value flows somewhere specific — a variable initializer,
 * or a call argument — it points `currentFeedTarget` at the destination
 * Binding, walks the subtree (any `Identifier` use found along the way
 * gets stamped with that target), and restores the previous target
 * afterwards. This save/restore discipline is what keeps flow tracking
 * correctly scoped when initializers nest (`const a = () => { const b = x }`
 * must feed `x` into `b`, not into `a`).
 *
 * Two flow-carrying subtrees are currently handled:
 *   - `VariableDeclarator` — the initializer feeds the declared variable.
 *   - `CallExpression` arguments — each argument feeds the matching
 *     declared parameter of the called function (see `Binding.params`).
 *
 * `currentFunc` is reserved for interprocedural flow (tracing values
 * through `return` back to a call site) — not wired up yet.
 */

import { parse } from "@typescript-eslint/typescript-estree";
import type { Binding, Kind, Scope, Results, Use } from "./types";
import { TSESTree } from "@typescript-eslint/typescript-estree";
import { resolve, dirname } from "path";

// loc gives us line numbers, which is off by default in typescript-estree.

// The file currently being walked. Stamped onto every Binding/Use created
// during the walk so cross-file linking (flow.ts) can tell them apart.
let currentFile = "";

// The declaration that a value currently being walked will flow into, or
// null if we're not inside a flow-carrying subtree. See "feeds mechanism"
// above.
let currentFeedTarget : Binding | null = null;

// The function the walker is currently inside. Reserved for interprocedural
// flow (return -> call site); not yet consumed anywhere.
let currentFunc : Binding | null = null;

/**
 * Build a `Binding` from an Identifier-like node (anything with a `.name`).
 * @param varType the `var`/`let`/`const` keyword for variable declarations,
 *   or `""`/`"N/A"` for binding kinds where a declaration keyword doesn't apply
 *   (params, functions, classes, ...).
 */
function makeBinding(
    idNode: any,
    role: Binding["role"],
    kind: Kind,
    varType = "",
): Binding {
    return {
        name: idNode.name,
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        varType,
        file: currentFile,
        kind,
        role,
        uses: [],
    };
}

/** Build a `Use` from an Identifier-like (or Literal, for computed keys) node. */
function makeUse(idNode: any): Use {
    return {
        name: idNode.name || idNode.value,
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        file: currentFile,
    };
}

/**
 * Entry point: walk one file's AST and return every declaration found in
 * it, with uses attached.
 *
 * A fresh scope stack is created per call so that repeated invocations
 * (one per file, from flow.ts) never leak declarations or the feed target
 * from a previous file's walk into the next.
 */
export function collectVariables(node: TSESTree.Node, file: string): Results {
    currentFile = file;
    const results: Results = { declarations: [] };
    // A stack to know which scope we're in, so that 2 or more variables with
    // the same name can be found without ambiguity. Created fresh per call so
    // repeated invocations don't leak declarations/uses from earlier walks.
    const stack: Scope[] = [{ name: "global", declarations: [], savedFeedTarget: null }];
    walkVariables(node, results, stack);
    results.declarations.push(...stack[0]!.declarations);   // save global
    return results;
}

/**
 * The recursive AST walker. Every node type with special handling below
 * either (a) registers a declaration, (b) resolves an `Identifier` against
 * the scope stack, (c) manages the feed target / scope stack around a
 * flow-carrying or scope-introducing subtree, or (d) prunes a subtree that
 * would otherwise produce false positives (type positions).
 *
 * Node types that manually recurse into their children (VariableDeclarator,
 * CallExpression) `return` early to avoid being walked a second time by the
 * generic fallback at the bottom. Node types that only need to register
 * something and still want their children visited normally (VariableDeclaration,
 * FunctionDeclaration, BlockStatement, ...) fall through instead.
 *
 * Because declarations are registered by their own specific node-type
 * handler (e.g. a function's params are collected up front), when the
 * generic fallback later re-visits those same identifier nodes, the
 * `Identifier` case's self-declaration check (`node.range[0] === found.start`)
 * recognizes them as the declaration site rather than misfiling them as a
 * use of themselves.
 */
function walkVariables(node: TSESTree.Node, results: Results, stack: Scope[]): void {
    // 1. null / undefined — skip
    if (node === null || node === undefined) {
        return;
    }

    // 2. primitives — nothing to descend into
    if (typeof node !== "object") {
        return;
    }

    // 3. arrays — recurse element-wise
    if (Array.isArray(node)) {
        for (const item of node) {
            walkVariables(item, results, stack);
        }
        return;
    }


    // A reference to a name. Search the scope stack innermost-first; the
    // first scope with a matching declaration wins (lexical shadowing).
    if (node.type === "Identifier") {
        for (let i = stack.length - 1; i >= 0; i--) {
            const found = stack[i]?.declarations.find(d => d.name === node.name);
            if (found) {
                // This identifier IS the declaration's own name node (not a
                // reference to it) — nothing to record, stop searching.
                if (node.range[0] === found.start) { break; }
                const use = makeUse(node);
                if (currentFeedTarget) {
                    use.feeds = {
                        name: currentFeedTarget.name,
                        file: currentFeedTarget.file,
                        line: currentFeedTarget.line,
                        start: currentFeedTarget.start,
                    };
                }
                // push the use that got stamped
                found.uses.push(use);
                break;
            }
        }
    }

    // import { parse } from "acorn" — each specifier binds a local name.
    // Registered with kind "import"; flow.ts later resolves these against
    // the real declaration in the imported file and merges the uses onto it.
    if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
            const binding = makeBinding(spec.local, "declaration", "import");
            binding.source = node.source.value;

            // Local (relative) imports get resolved to an absolute path so
            // flow.ts can key into its per-file results by that path.
            // KNOWN LIMITATION: hardcodes a ".ts" extension, so pure-JS
            // projects (.js/.jsx/.mjs sources) can fail to resolve here —
            // extraction still works, but the cross-file edge is silently
            // dropped. Bare package imports (non-relative `source`) are left
            // untouched and simply won't have a matching sourceResults entry.
            if (binding.source.startsWith(".")) {
                const importerDir = dirname(binding.file);
                const resolved = resolve(importerDir, binding.source) + ".ts";
                // Reset it to the absolute path, not relative
                binding.source = resolved;
            }

            stack[stack.length - 1]!.declarations.push(binding);
        }
    }

    // var/let/const (also for-of / for-in / classic for loop vars).
    // node.kind is the "var" | "let" | "const" keyword — record it as varType.
    // The id can be a destructuring pattern, so go through collectPatternNames;
    // the init is where uses live, so harvest those as "use" bindings.
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            // An arrow/function-expression initializer means this name is
            // really a function binding (so it can carry `.params` later),
            // not a plain variable — prevents `const foo = () => {}` from
            // being classified as "variable".
            const initType = decl.init?.type;
            const isFunction = initType === "ArrowFunctionExpression" || initType === "FunctionExpression";
            collectPatternNames(decl.id, stack[stack.length-1]!.declarations, isFunction ? "function" : "variable", node.kind);
        }
    }

    // The declarator's initializer is where the feeds relationship lives:
    // whatever gets used while walking `init` flows into the just-declared
    // binding, so point currentFeedTarget at it before descending.
    if (node.type === "VariableDeclarator") {
        const scopeDeclarations = stack[stack.length - 1]!.declarations;
        // The binding VariableDeclaration just pushed for this declarator —
        // relies on declaration order matching declarator order.
        const target = scopeDeclarations[scopeDeclarations.length - 1] ?? null;

        const previous = currentFeedTarget;   // save
        currentFeedTarget = target;           // set

        if (node.init) {                      // only if there's an init to walk
            walkVariables(node.init, results, stack); // walk — uses inside get stamped
        }

        currentFeedTarget = previous;         // restore
        return;
    }

    // A bare expression statement — e.g. `rank(query)` — references
    // variables without declaring anything. No special handling needed
    // here: its identifiers are picked up as ordinary uses by the generic
    // Identifier case above once the fallback recursion reaches them, since
    // this branch doesn't early-return. (Placeholder for future
    // assignment-expression flow — `x = foo()` — which isn't tracked yet.)
    if (node.type === "ExpressionStatement") {

    }

    // Functions: declaration, expression, arrow.
    // The function's own name plus every param (params can be defaults,
    // rest, or destructuring patterns).
    if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    ) {
        // Holds the Binding this function's params get attached to (see
        // Binding.params below) — either the function's own name binding,
        // or (for an anonymous function assigned to a variable) the
        // variable's binding.
        let funcBinding;

        // 1. Named function: register its name in the CURRENT (enclosing)
        // scope before pushing the new one, so recursive calls can find it.
        if (node.id) {
            funcBinding = makeBinding(node.id, "declaration", "function", "N/A");
            stack[stack.length - 1]!.declarations.push(funcBinding);
        } else {
            // Anonymous function (arrow / function expression) assigned to
            // a variable — e.g. `const foo = () => {}`. currentFeedTarget
            // was just pointed at that variable's binding by the enclosing
            // VariableDeclarator, so reuse it as the function binding.
            if (currentFeedTarget && (currentFeedTarget.kind === "function")) {
                funcBinding = currentFeedTarget;
            }
        }

        // 2. Flatten the param patterns into declarations, then push a new
        // scope for the function body headed by those params.
        const paramDeclarations: Binding[] = [];
        for (const param of node.params) {
            collectPatternNames(param, paramDeclarations, "param", "N/A");
        }

        if (funcBinding) {
            funcBinding.params = paramDeclarations;
        }
        stack.push({
            name: node.id?.name ?? "anonymous_func",
            declarations: paramDeclarations,
            savedFeedTarget: currentFeedTarget,
        });
        // Entering the function body isn't itself a flow-carrying
        // position — a use inside the body must not be recorded as
        // feeding the enclosing declaration. Restored on pop, below.
        currentFeedTarget = null;
    }

    // Call arguments feed the called function's declared parameters
    // (matched positionally by index), so that a chain like
    //   function foo(p) { return p; }
    //   const a = foo(z);
    // records `z` as feeding `foo`'s param `p`, in addition to `foo`
    // feeding `a` (handled by VariableDeclarator above). This is the
    // args -> params half of interprocedural flow tracking (v1.2).
    //
    // Only plain-identifier callees are handled (`foo(...)`); member-
    // expression calls (`obj.foo(...)`) and other callee shapes fall
    // through to the generic recursion below with no argument matching.
    if (node.type === "CallExpression") {
        if (node.callee.type === "Identifier") {
            const calleeName = node.callee.name;
            let calledFunc : Binding | undefined;
            for (let i = stack.length - 1; i >= 0; i--) {
                // the function that is called:
                calledFunc = stack[i]?.declarations.find((d : Binding) => d.name === calleeName);
                if (calledFunc) break;
            }

            let save;
            for (let argIndex = 0; argIndex < node.arguments.length; argIndex++) {
                save = currentFeedTarget;
                // No matching param (fewer declared params than args, or
                // the callee couldn't be resolved) — walk with no feed
                // target rather than skipping the argument entirely.
                currentFeedTarget = calledFunc?.params?.[argIndex] ?? null;
                const arg = node.arguments[argIndex];
                if (arg) walkVariables(arg, results, stack);   // guard: fewer args than params
                currentFeedTarget = save;
            }

            walkVariables(node.callee, results, stack);
            return;
        }
    }

    // let/const declared inside `{ }` are block-scoped: push a fresh scope
    // so they don't leak into (or collide with) the enclosing scope.
    if (node.type === "BlockStatement") {
        stack.push({
            name: "block",
            declarations: [],
            savedFeedTarget: currentFeedTarget,
        })
    }

    // try {} catch (err) {} — the catch param (optional since ES2019).
    // NOTE: unlike every other binding form above, this is pushed straight
    // onto the top-level `results.declarations` rather than onto the scope
    // stack — an existing asymmetry, not scope-correct, but left as-is.
    if (node.type === "CatchClause" && node.param) {
        collectPatternNames(node.param, results.declarations, "catch");
    }

    // class Ranker {} — the class name.
    // Same asymmetry as CatchClause: goes straight to results.declarations,
    // bypassing the scope stack.
    if (node.type === "ClassDeclaration" && node.id) {
        results.declarations.push(makeBinding(node.id, "declaration", "class"));
    }

    // score(result) {} — the method name; its params are picked up when
    // recursion reaches the method's FunctionExpression value. Also goes
    // straight to results.declarations (see note above).
    if (node.type === "MethodDefinition") {
        results.declarations.push(makeBinding(node.key, "declaration", "function"));
    }

    // TS-only declarations: enum Mode, interface Config, type Result.
    // Also registered straight to results.declarations.
    if (
        node.type === "TSEnumDeclaration" ||
        node.type === "TSInterfaceDeclaration" ||
        node.type === "TSTypeAliasDeclaration"
    ) {
        results.declarations.push(makeBinding(node.id, "declaration", "type"));
    }

    // Don't recurse into TypeAnnotation since it's just noise
    // and incorrectly puts the variable into uses array.
    if (node.type === "TSTypeAnnotation") {
        return;
    }

    // 4. plain object (any node type not fully handled by an early return
    // above) — recurse into every value. This is also what visits the
    // *bodies* of nodes that registered something and fell through, e.g. a
    // function's `body` and (again, harmlessly — see self-declaration check
    // in the Identifier case) its `params`.
    for (const value of Object.values(node)) {
        walkVariables(value, results, stack);
    }

    // Pop phase: once a function body or block has been fully walked
    // (including the generic recursion just above), flush its scope's
    // declarations into the file-level results and restore whatever feed
    // target was active before we entered it.
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
        const closing = stack[stack.length - 1]!;
        currentFeedTarget = closing.savedFeedTarget;
        results.declarations.push(...closing.declarations);
        stack.pop();
    }

    if (node.type === "BlockStatement") {
        const closing = stack[stack.length - 1]!;
        currentFeedTarget = closing.savedFeedTarget;
        results.declarations.push(...closing.declarations);
        stack.pop();
    }
}

/**
 * Flatten a binding-position pattern into a list of `Binding`s.
 *
 * A binding position (variable id, function param, catch param) isn't
 * always a plain identifier — it can be a destructuring pattern, a
 * default value, or a rest element, and these nest inside each other
 * (`{ a, b: [c, ...d] = [] }` is one pattern with four leaf names).
 *
 * @param kind the Kind to tag every leaf identifier found beneath this
 *   pattern with (e.g. "param", "variable", "catch").
 * @param varType the var/let/const keyword, threaded through to every leaf.
 */
export function collectPatternNames(pattern: TSESTree.Node | null, declarations: Binding[], kind: Kind, varType = "") {
    if (pattern === null || pattern === undefined) {
        return;
    }

    switch (pattern.type) {
        // x
        case "Identifier":
            declarations.push(makeBinding(pattern, "declaration", kind, varType));
            break;

        // { query, limit = 10 } — each property's value is itself a pattern;
        // { ...rest } shows up as a RestElement among the properties
        case "ObjectPattern":
            for (const prop of pattern.properties) {
                if (prop.type === "Property") {
                    collectPatternNames(prop.value, declarations, kind, varType);
                } else {
                    collectPatternNames(prop, declarations, kind, varType); // RestElement
                }
            }
            break;


        // [a, b] — each element is itself a pattern (and may be a hole, i.e. null)
        case "ArrayPattern":
            for (const element of pattern.elements) {
                collectPatternNames(element, declarations, kind, varType);
            }
            break;

        // y = 5 — the name lives on the left, the default on the right
        case "AssignmentPattern":
            collectPatternNames(pattern.left, declarations, kind, varType);
            break;

        // ...args
        case "RestElement":
            collectPatternNames(pattern.argument, declarations, kind, varType);
            break;
    }
}
