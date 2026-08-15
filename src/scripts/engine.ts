import type { Binding, Kind, Scope, Results, Use } from "./types";
import { TSESTree } from "@typescript-eslint/typescript-estree";
import { resolve, dirname } from "path";
// loc gives us line numbers, which is off by default in typescript-estree.

// Define the file
let currentFile = "";

// Define the variable that is fed
// A list, not a single binding: `const { a, b } = foo()` has one initializer
// feeding two declarations at once. Empty means "not in a flow-carrying
// position", which is what `null` used to mean.
let currentFeedTargets : Binding[] = [];

// Define the function the walker is currently in.
let currentFunction : Binding | null = null;

// Define whether we're in a ReturnStatement or not.
let inReturnStatement = false;

/**
 * A use that did NOT resolve when the walk reached it, held for a
 * second attempt once the walk is over -- this is what makes forward references 
 * work (E.g. `foo(); function foo() {}`, `const a = b; const b = 2`).
 * 
 * `chain` is a *shallow* copy of the scope stack: the array is snapshotted
 * so the later pushes/pops can't disturb it, but the `Scope` objects inside
 * are the live ones, so their `declarations` keep filling as the walk continues
 * and are complete by retry time. That is the whole trick -- no second walk, 
 * no pre-pass, just a deferred lookup until the scopes it needs are finished
 * 
 * `use` is built at the point of use, so it already carries the `feeds` that
 * `currentFeedTargets` held back then; `inReturn/fn` are captured for the same
 * reason, since both are mutable module state that won't survive.
 * 
 * Think of it as a sticky note of reminder (when a use doesn't
 * get resolved because it's not declared, it's pending to be resolved
 * until the walker rewalks it.)
 */
type PendingUse = {
    use: Use; // Represents the use itself.
    chain: Scope[]; // Represents where the use was standing (in which scope?) when it got a "pending" state.
    inReturnStatement: boolean; // Whether the pending use was in a return statement.
    fn: Binding | null; // Which function the use was in.
}

let pendingUses: PendingUse[] = [];

/**
 * One thing the walker did, reported to whoever is watching. `kind` groups
 * them (declare / resolve / defer / feed / scope), `detail` is the human
 * sentence, `depth` is how deeply nested it was so a printer can indent.
 */
export type TraceEvent = { kind: string; detail: string; depth: number };

/**
 * Tracing hook — null in every normal run, so the whole mechanism costs one
 * null check per event and nothing else. `trace.ts` sets it to watch a walk
 * happen step by step.
 *
 * These events live in here rather than in trace.ts because they describe
 * moments *inside* the walk — which scope was open, what the feed target was
 * — and none of that is visible from outside once `collectVariables` returns.
 */
let onTrace: ((event: TraceEvent) => void) | null = null;
let traceDepth = 0;

/** Start (or, with null, stop) watching the walk. See trace.ts. */
export function setTraceHook(hook: ((event: TraceEvent) => void) | null): void {
    onTrace = hook;
    traceDepth = 0;
}

/**
 * Report one event. `depthChange` is +1 for "everything after this is nested
 * inside it" (entering a scope) and -1 for leaving one; the decrement happens
 * before reporting so the closing line sits at the same indent as its opener.
 */
function trace(kind: string, detail: string, depthChange: 0 | 1 | -1 = 0): void {
    if (!onTrace) return;
    if (depthChange === -1) traceDepth--;
    onTrace({ kind, detail, depth: traceDepth });
    if (depthChange === 1) traceDepth++;
}

/** Innermost-scope-outward lookup of `name` or undefined if there is nothing binding to it */
function lookup(name: string, chain: Scope[]): Binding | undefined {
    for (let i = chain.length - 1; i >= 0; i--) {
        const found = chain[i]?.declarations.find(d => d.name === name);
        if (found) return found;
    }

    return undefined;
}

/**
 * Record `use` against the declaration it resolved to, and - if it happend 
 * inside a return - note on the enclosing function that this declaration
 * escapes through it. Shared by the immediate path and the deferred retry 
 * so a forward reference inside a `return` still stamps `returns`.
 */
function attachUse(found: Binding, use: Use, wasInReturnStatement: boolean, fn: Binding | null): void {
    if (wasInReturnStatement && fn) {
        if (!Array.isArray(fn.returns)) {
            fn.returns = [];
        }
        const alreadyIn = fn.returns.some(
            r => r.start === found.start && r.file === found.file
        );
        if (!alreadyIn) {
            // push the IDENTITY of the thing being returned:
            fn.returns.push({ name: found.name, file: found.file, start: found.start });
        }
    }

    found.uses.push(use);
}

// Build a Binding from an Identifier-like node (something with a `.name`).
// varType is the declaration keyword (var/let/const) for variables, and ""
// for binding kinds where it doesn't apply (params, functions, ...).
function makeBinding(
    idNode: any,
    role: Binding["role"],
    kind: Kind,
    varType = "",
): Binding {
    return {
        name: idNode.name ?? String(idNode.value),
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        varType,
        file: currentFile,
        kind,
        role,
        uses: [],
    };
}

// Build a Use from an Identifier-like node.
function makeUse(idNode: any): Use {
    return {
        name: idNode.name || String(idNode.value),
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        file: currentFile,
    };
}

export function collectVariables(node: TSESTree.Node, file: string): Results {
    currentFile = file;
    // reset so that the pending uses from one file does not
    // leak into another file.
    pendingUses = [];
    const results: Results = { declarations: [] };
    // A stack to know which scope we're in, so that 2 or more variables with
    // the same name can be found without ambiguity. Created fresh per call so
    // repeated invocations don't leak declarations/uses from earlier walks.
    const stack: Scope[] = [{ name: "global", declarations: [], savedFeedTargets: [], savedFunction: null }];
    walkVariables(node, results, stack);
    results.declarations.push(...stack[0]!.declarations);   // save global
    // Re-lookup: Every declaration is walked with pendingUses so it's 
    // time for pending uses to resolve.

    let stillUnresolved = 0;
    for (const note of pendingUses) {
        const found = lookup(note.use.name, note.chain);
        // Nothing binds this name even now that every scope is complete —
        // an import we don't follow, a global, a typo. Only THIS note fails;
        // the rest are unrelated, so carry on rather than abandoning them.
        if (!found) {
            stillUnresolved++;
            continue;
        }
        // it's its own start, skip
        if (found.start === note.use.start) {
            continue;
        }
        attachUse(found, note.use, note.inReturnStatement, note.fn);
    }

    trace("phase", `walk finished — ${stillUnresolved} deferred use(s) still unresolved`);
    return results;
}

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


    if (node.type === "Identifier") {
        // create a use of the node
        const use = makeUse(node);
        // populate feeds from currentFeedTargets
        if (currentFeedTargets.length > 0) {
            use.feeds = currentFeedTargets.map(t => ({
                name: t.name,
                file: t.file,
                line: t.line,
                start: t.start,
            }));
        }
        // 
        // Looks up the declaration of this identifier name in the scope stack,
        // returning the nearest matching declared variable/function/param, or undefined if not found
        const feedNote = use.feeds ? ` (feeds ${use.feeds.map(f => f.name).join(" + ")})` : "";

        const found = lookup(node.name, stack);
        if (found) {
            // Resolve this identifier use to its declaration if found, else mark as pending.
            // An identifier that is a declaration is not a use (if statement checks this, if truthy,
            // attaches the use)
            if (node.range[0] !== found.start) {
                trace("resolve", `${node.name} at offset ${node.range[0]} -> declaration at offset ${found.start}${feedNote}`);
                attachUse(found, use, inReturnStatement, currentFunction);
            } else {
                trace("skip", `${node.name} at offset ${node.range[0]} is its own declaration, not a use of itself`);
            }
        } else {
            // Add use to pendingUses for later resolution when declaration is found
            trace("defer", `${node.name} at offset ${node.range[0]} — no declaration of that name in scope yet${feedNote}`);
            pendingUses.push({ use, chain: [...stack], inReturnStatement, fn: currentFunction });
        }
    }

    // import { parse } from "acorn" — each specifier binds a local name
    if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
            const binding = makeBinding(spec.local, "declaration", "import");
            binding.source = node.source.value;

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
    // Each declarator is handled here rather than in a separate
    // `VariableDeclarator` branch, because a declarator on its own can't see
    // `node.kind` (the var/let/const keyword) and — more importantly — can't
    // tell which bindings are *its own*. Slicing the scope's declarations
    // around each collectPatternNames call pairs a declarator with exactly
    // the names it introduced, which is what the feed target has to be.
    //
    // The old code took "the last declaration in scope" as the target. That
    // was wrong twice over: `const { a, b } = foo()` fed only `b`, and
    // `const a = foo(), b = 2` fed `b` — a variable foo has nothing to do
    // with — because every declarator's names were pushed up front.
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            // grabs the top (latest) list. 
            const scopeDeclarations = stack[stack.length - 1]!.declarations;
            const before = scopeDeclarations.length;

            // Prevent the classification of all "id" fields as variables
            const initType = decl.init?.type;
            const isFunction = initType === "ArrowFunctionExpression" || initType === "FunctionExpression";
            // sends it over to collectPatternNames with the top list
            // (it first checks if the type is a function expression (see above) to send the correct "kind")
            collectPatternNames(decl.id, scopeDeclarations, isFunction ? "function" : "variable", node.kind);

            // Everything pushed by this declarator — one name normally, several
            // for a destructuring pattern, none for `let x` with no init.
            const targets = scopeDeclarations.slice(before);

            const previous = currentFeedTargets;   // save
            currentFeedTargets = targets;          // set
            if (targets.length) trace("feed", `anything used from here flows into ${targets.map(t => t.name).join(" + ")}`, 1);

            if (decl.init) {                       // only if there's an init to walk
                walkVariables(decl.init, results, stack); // walk — uses inside get stamped
            }

            if (targets.length) trace("feed", `done — ${targets.map(t => t.name).join(" + ")} no longer the target`, -1);
            currentFeedTargets = previous;         // restore
        }
        return;   // declarators are walked above; don't let the generic loop repeat them
    }

    // Loops: walk the children in *source* order rather than the parser's.
    //
    // The generic recursion at the bottom of this function iterates
    // `Object.values(node)`, and typescript-estree emits a node's properties
    // alphabetically — so `body` comes before `init`, `left`, `test` and
    // `update`. The walker was therefore visiting a loop's body before the
    // loop's own variable had been declared, and
    // `for (let i = 0; i < 3; i++) { const b = i; }` dropped the use of `i`
    // inside the body while still resolving the two in `i < 3` and `i++`
    // (those are walked after `init`, so by then it exists). Naming the
    // children explicitly is the same move VariableDeclaration and
    // MethodDefinition already make to control their own traversal.
    //
    // Note this is *not* the hoisting gap: nothing here is used before it is
    // declared in the source, only before the walker happened to reach it.
    if (node.type === "ForStatement") {
        if (node.init) walkVariables(node.init, results, stack);
        if (node.test) walkVariables(node.test, results, stack);
        if (node.update) walkVariables(node.update, results, stack);
        walkVariables(node.body, results, stack);
        return;
    }

    // for (const x of xs) / for (const k in o) — `left` declares the loop
    // variable and `right` is the iterable being read; both have to be walked
    // before the body that uses them.
    if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
        walkVariables(node.left, results, stack);
        walkVariables(node.right, results, stack);
        walkVariables(node.body, results, stack);
        return;
    }

    // { a: b } — an object literal property. A non-computed key is a label,
    // not a reference: the `a` names the property, so walking it would resolve
    // to any variable that happens to also be called `a` and record a use that
    // isn't in the source. Shorthand { z } is the same problem twice over —
    // key and value are separate nodes at the same offset, so `z` got two
    // identical uses. Only a computed key, { [k]: v }, really does read a
    // variable. Same computed/non-computed split as MethodDefinition's key
    // and a MemberExpression's property.
    if (node.type === "Property") {
        if (node.computed) walkVariables(node.key, results, stack);
        walkVariables(node.value, results, stack);
        return;
    }

    if (node.type === "ReturnStatement") {
        const previous = inReturnStatement;
        inReturnStatement = true;
        // node.argument contains the expression (x + y, {a, b}, c, etc.)
        // that is returned

        // Since there can also be empty returns: add a conditional that
        // triggers walkVariables only if node.argument exists
        // If it is an empty return statement, we don't need to walk it. 

        if (node.argument)
            walkVariables(node.argument, results, stack);

        inReturnStatement = previous;
        return;
    }

    // Functions: declaration, expression, arrow.
    // The function's own name plus every param (params can be defaults,
    // rest, or destructuring patterns).
    if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    ) {
        // store the binding in a variable to later attach it to the param field 
        // of the Binding type.
        let funcBinding;

        // if the function has an ID (meaning it isn't an anonymous function)
        // write the function in the current stack (not a separate one)
        if (node.id) {
            trace("declare", `${node.id.name} (function) at offset ${node.id.range[0]}`);
            funcBinding = makeBinding(node.id, "declaration", "function", "N/A");
            stack[stack.length - 1]!.declarations.push(funcBinding);
        } else {
            // If there is no node.id (anonymous function), check whether a feed
            // target is available and treat it as the function binding to which
            // to attach params later. Only a lone target can name a function —
            // `const { a, b } = () => {}` has two, and neither is the function.
            if (currentFeedTargets.length === 1 && currentFeedTargets[0]!.kind === "function") {
                funcBinding = currentFeedTargets[0];
            }
        }
    
        // Build a parameter list with type Binding, THIS is the list that
        // needs to be separate from the stack list. 
        // Fill in the param list 
        const paramDeclarations: Binding[] = [];
        for (const param of node.params) {
            collectPatternNames(param, paramDeclarations, "param", "N/A");
        }
        
        // if there is a funcBinding, set it to the filled paramDeclarations list.
        if (funcBinding) {
            funcBinding.params = paramDeclarations;
        }
        trace("scope", `enter function ${node.id?.name ?? "(anonymous)"} — its parameters start this scope`, 1);
        // push the function now that params are filled in paramDeclarations
        stack.push({
            name: node.id?.name ?? "anonymous_func",
            declarations: paramDeclarations,
            savedFeedTargets: currentFeedTargets,
            savedFunction: currentFunction,
        });
        // Clear the list of currentFeedTargets because we are now inside a new function scope,
        // so there are no flow-carrying targets to link variable uses to at this level.
        currentFeedTargets = [];
        // Set the currentFunction to the current function's binding (funcBinding),
        // or to null if there is no function binding. This keeps track of which function
        // scope we are currently in, which is important for identifying return statements
        // and properly attributing variable uses that escape through return.
        currentFunction = funcBinding ?? null;
    }

    // Arguments need to feed the parameters, i.e., 
    // args and params must match 

    // End result we're trying to achieve: 

    /*
        "params": [
            {
              "name": "p",
              "line": 1,
              "start": 13,
              "varType": "N/A",
              "file": "/Users/temiralimov/Desktop/flowdata/src/tests/example.ts",
              "kind": "param",
              "role": "declaration",
              "uses": [
                {
                  "name": "p",
                  "line": 1,
                  "start": 34,
                  "file": "/Users/temiralimov/Desktop/flowdata/src/tests/example.ts"
   NEW PROP ----> "feeds": {
                    "name": ARG name
                    ... rest of arg's properties
                  }       
                }
              ]
            }
          ]
    */

    if (node.type === "CallExpression") {
        let calleeName: string | undefined;
        if (node.callee.type === "Identifier") {
            // Plain call ==> the name is at node.callee.name
            calleeName = node.callee.name;
        } else if (node.callee.type === "MemberExpression" && !node.callee.computed) {
            // Method (dotted) call ==> the name is at node.callee.property.name
            calleeName = node.callee.property.name;
        }

        if (calleeName !== undefined) {
            let calledFunc: Binding | undefined;
            for (let i = stack.length - 1; i >= 0; i--) {
                calledFunc = stack[i]?.declarations.find((d: Binding) => d.name === calleeName);
                if (calledFunc) break;
            }

            let save;
            for (let argIndex = 0; argIndex < node.arguments.length; argIndex++) {
                save = currentFeedTargets;
                const param = calledFunc?.params?.[argIndex];
                currentFeedTargets = param ? [param] : [];
                const arg = node.arguments[argIndex];
                if (arg) walkVariables(arg, results, stack);   // guard: fewer args than params
                currentFeedTargets = save;
            }

            walkVariables(node.callee, results, stack);
            return;
        }
    }

    if (node.type === "BlockStatement") {
        trace("scope", "enter block { } — names declared inside are invisible once it closes", 1);
        // Push a new stack but there is no declarations
        stack.push({
            name: "block",
            declarations: [],
            savedFeedTargets: currentFeedTargets,
            savedFunction: currentFunction,
        })
    }

    // try {} catch (err) {} — the catch param (optional since ES2019)
    if (node.type === "CatchClause" && node.param) {
        // collectPatternNames already pushes when it comes across an identifier; no need
        // to push additionally here. push to the stack instead of results.declarations list.
        collectPatternNames(node.param, stack[stack.length - 1]!.declarations, "catch");
    }

    // class Ranker {} — the class name
    if (node.type === "ClassDeclaration" && node.id) {
        stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "class"));
    }

    // score(result) {} — the name lives on node.key, the params on node.value.
    // That value is an anonymous FunctionExpression (id is always null for a
    // method), so the function branch can't name it from node.id; for anonymous
    // functions it falls back to currentFeedTarget instead. Point that at the
    // binding we just made and walk the value ourselves, so the params (and,
    // via currentFunction, the returns) land on the method. Same
    // save/set/walk/restore shape VariableDeclarator uses for `const f = () => {}`.
    if (node.type === "MethodDefinition") {
        // class R { [name]() {} } — a computed key is an expression, not the
        // method's name. Binding it would declare something called "name",
        // which is the variable being read, not the method it names (and the
        // real name isn't knowable until runtime). So walk the key as an
        // ordinary expression instead, letting `name` resolve to its own
        // declaration and record a use there.
        if (node.computed) {
            walkVariables(node.key, results, stack);
            walkVariables(node.value, results, stack);
            return;
        }

        const methodBinding = makeBinding(node.key, "declaration", "function");
        stack[stack.length - 1]?.declarations.push(methodBinding);

        const previous = currentFeedTargets; // save the old value
        currentFeedTargets = [methodBinding]; // set
        walkVariables(node.value, results, stack); // walk 
        currentFeedTargets = previous; // restore
        return; // node.key is the declaration itself, nothing to resolve there.
    }

    /*
        Reassignment — gap 5. Note what was actually missing: in `let x; x = foo()`
        both identifiers already resolved, `x` to its declaration and `foo` to its
        function. What no one recorded is that foo's value lands in x, because only
        a declaration's initializer ever set a feed target. So this is not a
        resolution problem, it's a missing `feeds` stamp — the fix belongs here and
        not anywhere near `lookup`.

        The branch does for `x = foo()` what the VariableDeclaration branch does for
        `const x = foo()`: point currentFeedTargets at the thing being written, walk
        the right-hand side so the uses inside get stamped, then restore.

        Two details that look arbitrary and aren't:

        - `left` is walked BEFORE the target is set. Walking it after would stamp the
          write as flowing into itself, so `x = 1` would emit `x -> x`.
        - When the left side can't be named — `o.p = foo()`, or an identifier that
          resolves to nothing — the target falls back to `previous` rather than [].
          Not naming the write target says nothing about where the expression's own
          value goes, and `const a = (o.p = foo())` really does put foo's result in
          `a`. [] would throw that away.
    */
    if (node.type === "AssignmentExpression") {
        walkVariables(node.left, results, stack);
        const previous : Binding[] = currentFeedTargets;

        if (node.left.type === "Identifier") {
            const resolvedLeftNode = lookup(node.left.name, stack);
            currentFeedTargets = resolvedLeftNode  ? [resolvedLeftNode] : previous;
        }
        walkVariables(node.right, results, stack);
        // Restore currentFeedTargets to its previous value after handling AssignmentExpression
        currentFeedTargets = previous;
        return;
    }

    // TS-only declarations: enum Mode, interface Config, type Result
    if (
        node.type === "TSEnumDeclaration" ||
        node.type === "TSInterfaceDeclaration" ||
        node.type === "TSTypeAliasDeclaration"
    ) {
       stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "type"));
    }

    // Don't recurse into TypeAnnotation since it's just noise
    // and incorrectly puts the variable into uses array.
    if (node.type === "TSTypeAnnotation") {
        return;
    }

    // 4. plain object — recurse into every value.
    //
    // This is also the default handler for every node type without a branch
    // above. A bare expression statement — `rank(query)` — needs no case of
    // its own for exactly that reason: nothing in it declares anything, so
    // recursing generically makes every identifier inside it a use, which is
    // the correct answer.
    for (const value of Object.values(node)) {
        walkVariables(value, results, stack);
    }

        // AFTER the Object.values loop (pop):
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
        trace("scope", "leave function — its declarations move into the results list", -1);
        // get the top list
        const closing = stack[stack.length - 1]!;
        // Restore feed targets and function context when leaving a function scope
        currentFeedTargets = closing.savedFeedTargets ?? [];
        currentFunction = closing.savedFunction ?? null;

        // save the top list in results
        results.declarations.push(...closing.declarations);
        // pop it from the stack (stops being findable)
        stack.pop();
    }
    
    if (node.type === "BlockStatement") {
        trace("scope", "leave block — its declarations move into the results list", -1);
        const closing = stack[stack.length - 1]!;
        currentFeedTargets = closing.savedFeedTargets;
        currentFunction = closing.savedFunction;
        results.declarations.push(...closing.declarations);
        stack.pop();
    }
}

// A binding position (variable id, function param, catch param) isn't always
// a plain identifier — it can be a destructuring pattern, a default value,
// or a rest element, and these nest inside each other. `kind` is the kind to
// tag every name found beneath this pattern with; `varType` carries the
// var/let/const keyword through to each leaf identifier.
export function collectPatternNames(pattern: TSESTree.Node | null, declarations: Binding[], kind: Kind, varType = "") {
    if (pattern === null || pattern === undefined) {
        return;
    }

    switch (pattern.type) {
        // If the type is an identifier, it makes a Binding with a "declaration" tag
        // (because the variable is being declared)
        case "Identifier":
            trace("declare", `${pattern.name} (${kind}) at offset ${pattern.range[0]}`);
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
