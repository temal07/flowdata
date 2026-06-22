import { parse } from "@typescript-eslint/typescript-estree";


const code = await Bun.file("example.ts").text();
const tree = parse(code);
console.log(JSON.stringify(tree, null, 2));
console.log(collectVariables(tree));
 
// until it finds a node whose type is VariableDeclaration, then grabs
// the variable name by node.declarations.id.name;
function collectVariables(node: any, collection : string[] = []) {
    // 4 cases
    // String/numbers
    // Array
    // Object
    // null/undefined
    
    // 1. If the node is null or undefined, return (skip)
    if (node === null || node === undefined) {
        return collection;
    }

    // 2. If the node is not an object, just return the node,
    // no need for additional steps
    if (typeof node !== "object") {
        return collection;
    }

    // 3. If the node is an Array (check with Array.isArray), then
    // use recursion until you hit
    if (Array.isArray(node)) {
        for (const item of node) {
            collectVariables(item, collection);
        }

        return collection;
    }

    // import { parse } from "acorn" — each specifier binds a local name
    if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
            collection.push(spec.local.name);
        }
    }

    // var/let/const — also covers for-of, for-in and classic for, since
    // their loop variable is itself a VariableDeclaration.
    // The id can be a destructuring pattern, so go through collectPatternNames.
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            collectPatternNames(decl.id, collection);
        }
    }

    // Functions: declaration, expression, arrow.
    // The function's own name (function f() {}) plus every param —
    // params can be defaults, rest, or destructuring patterns.
    if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    ) {
        if (node.id) {
            collection.push(node.id.name);
        }
        for (const param of node.params) {
            collectPatternNames(param, collection);
        }
    }

    // try {} catch (err) {} — the catch param (optional since ES2019)
    if (node.type === "CatchClause" && node.param) {
        collectPatternNames(node.param, collection);
    }

    // class Ranker {} — the class name
    if (node.type === "ClassDeclaration" && node.id) {
        collection.push(node.id.name);
    }

    // score(result) {} — the method name; its params are picked up when
    // recursion reaches the method's FunctionExpression value
    if (node.type === "MethodDefinition") {
        collection.push(node.key.name);
    }

    // TS-only declarations: enum Mode, interface Config, type Result
    if (
        node.type === "TSEnumDeclaration" ||
        node.type === "TSInterfaceDeclaration" ||
        node.type === "TSTypeAliasDeclaration"
    ) {
        collection.push(node.id.name);
    }

    // 4. Objects: Do recursion
    for (const value of Object.values(node)) {
        collectVariables(value, collection);
    }

    return collection;
}

// A binding position (variable id, function param, catch param) isn't always
// a plain identifier — it can be a destructuring pattern, a default value,
// or a rest element, and these nest inside each other.
function collectPatternNames(pattern: any, collection: string[]) {
    if (pattern === null || pattern === undefined) {
        return;
    }

    switch (pattern.type) {
        // x
        case "Identifier":
            collection.push(pattern.name);
            break;

        // { query, limit = 10 } — each property's value is itself a pattern;
        // { ...rest } shows up as a RestElement among the properties
        case "ObjectPattern":
            for (const prop of pattern.properties) {
                if (prop.type === "Property") {
                    collectPatternNames(prop.value, collection);
                } else {
                    collectPatternNames(prop, collection); // RestElement
                }
            }
            break;

        // [first, ...rest] — elements can be null for holes: [, second]
        case "ArrayPattern":
            for (const element of pattern.elements) {
                collectPatternNames(element, collection);
            }
            break;

        // y = 5 — the name lives on the left, the default on the right
        case "AssignmentPattern":
            collectPatternNames(pattern.left, collection);
            break;

        // ...args
        case "RestElement":
            collectPatternNames(pattern.argument, collection);
            break;
    }
}