import { parse } from "@typescript-eslint/typescript-estree";
import type { Binding, Kind, Scope, Results, Use } from "./types";
import { TSESTree } from "@typescript-eslint/typescript-estree";
import { resolve, dirname } from "path";

// loc gives us line numbers, which is off by default in typescript-estree.

// Define the file
let currentFile = "";

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

// Build a Use from an Identifier-like node.
function makeUse(idNode: any): Use {
    return {
        name: idNode.name,
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        file: currentFile,
    };
}

export function collectVariables(node: TSESTree.Node, file: string): Results {
    currentFile = file;
    const results: Results = { declarations: [] };
    // A stack to know which scope we're in, so that 2 or more variables with
    // the same name can be found without ambiguity. Created fresh per call so
    // repeated invocations don't leak declarations/uses from earlier walks.
    const stack: Scope[] = [{ name: "global", declarations: [] }];
    walkVariables(node, results, stack);
    results.declarations.push(...stack[0]!.declarations);   // save global
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
        for (let i = stack.length - 1; i >= 0; i--) {
            // A found 
            const found = stack[i]?.declarations.find(d => d.name === node.name);
            if (found) {
                if (node.range[0] === found.start) { break; }
                found.uses.push(makeUse(node));
                break;
            }
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
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            collectPatternNames(decl.id, stack[stack.length -1]!.declarations, "variable", node.kind);
        }
    }

    // A bare expression statement — e.g. `rank(query)` — references variables
    // without declaring anything, so its identifiers are all uses.
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
        // 1. Put the function's name in the CURRENT scope (before pushing the new one)
        // This adds to the DECLARATIONS array that is one of stack's keys which is an array
        if (node.id) {
            stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "function", "N/A"));
        }
    
        // 2. Build the params, then push the function's own new scope
        // This adds a COMPLETELY NEW SCOPE to the stack ITSELF
        const paramDeclarations: Binding[] = [];
        for (const param of node.params) {
            collectPatternNames(param, paramDeclarations, "param", "N/A");
        }
        stack.push({
            name: node.id?.name ?? "anonymous_func",
            declarations: paramDeclarations
        });
    }

    if (node.type === "BlockStatement") {
        stack.push({
            name: "block",
            declarations: [],
        })
    }

    // try {} catch (err) {} — the catch param (optional since ES2019)
    if (node.type === "CatchClause" && node.param) {
        collectPatternNames(node.param, results.declarations, "catch");
    }

    // class Ranker {} — the class name
    if (node.type === "ClassDeclaration" && node.id) {
        results.declarations.push(makeBinding(node.id, "declaration", "class"));
    }

    // score(result) {} — the method name; its params are picked up when
    // recursion reaches the method's FunctionExpression value
    if (node.type === "MethodDefinition") {
        results.declarations.push(makeBinding(node.key, "declaration", "function"));
    }

    // TS-only declarations: enum Mode, interface Config, type Result
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

    // 4. plain object — recurse into every value
    for (const value of Object.values(node)) {
        walkVariables(value, results, stack);
    }

        // AFTER the Object.values loop (pop):
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
        const closing = stack[stack.length - 1]!;
        results.declarations.push(...closing.declarations);
        stack.pop();
    }
    
    if (node.type === "BlockStatement") {
        const closing = stack[stack.length - 1]!;
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
