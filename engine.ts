import { parse } from "@typescript-eslint/typescript-estree";
import type { Binding, Kind } from "./types";

export interface Results {
    uses: Binding[];
    declarations: Binding[];
}

const FILE = "example.ts";
const code = await Bun.file(FILE).text();

// loc gives us line numbers, which is off by default in typescript-estree.
const tree = parse(code, { loc: true });

console.log(collectVariables(tree));

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
        varType,
        file: FILE,
        kind,
        role,
    };
}


export function collectVariables(node: any): Results {
    const results: Results = { uses: [], declarations: [] };
    walkVariables(node, results);
    return results;
}

function walkVariables(node: any, results: Results): void {
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
            walkVariables(item, results);
        }
        return;
    }

    // import { parse } from "acorn" — each specifier binds a local name
    if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
            results.declarations.push(makeBinding(spec.local, "declaration", "variable"));
        }
    }

    // var/let/const (also for-of / for-in / classic for loop vars).
    // node.kind is the "var" | "let" | "const" keyword — record it as varType.
    // The id can be a destructuring pattern, so go through collectPatternNames;
    // the init is where uses live, so harvest those as "use" bindings.
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            collectPatternNames(decl.id, results.declarations, "variable", node.kind);
            collectUses(decl.init, results.uses);
        }
    }

    // A bare expression statement — e.g. `rank(query)` — references variables
    // without declaring anything, so its identifiers are all uses.
    if (node.type === "ExpressionStatement") {
        collectUses(node.expression, results.uses);
    }

    // Functions: declaration, expression, arrow.
    // The function's own name plus every param (params can be defaults,
    // rest, or destructuring patterns).
    if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    ) {
        if (node.id) {
            results.declarations.push(makeBinding(node.id, "declaration", "function"));
        }
        for (const param of node.params) {
            collectPatternNames(param, results.declarations, "param");
        }
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

    // 4. plain object — recurse into every value
    for (const value of Object.values(node)) {
        walkVariables(value, results);
    }
}

// A binding position (variable id, function param, catch param) isn't always
// a plain identifier — it can be a destructuring pattern, a default value,
// or a rest element, and these nest inside each other. `kind` is the kind to
// tag every name found beneath this pattern with; `varType` carries the
// var/let/const keyword through to each leaf identifier.
export function collectPatternNames(pattern: any, declarations: Binding[], kind: Kind, varType = "") {
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

        // [first, ...rest] — elements can be null for holes: [, second]
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

// Walk an initializer expression and record every identifier referenced in it
// as a "use" binding.
export function collectUses(node: any, uses: Binding[]) {
    // Same base cases as collectVariables: skip null/undefined and non-objects.
    // Without this, recursing into a string would loop forever
    // (Object.values("a") === ["a"]).
    if (node === null || node === undefined || typeof node !== "object") {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectUses(item, uses);
        }
        return;
    }

    if (node.type === "Identifier") {
        uses.push(makeBinding(node, "use", "variable"));
    }

    for (const value of Object.values(node)) {
        collectUses(value, uses);
    }
}
