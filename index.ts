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
        return;
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

        return node;
    }

    // If the type of the node is VariableDeclaration:
    if (node.type === "VariableDeclaration") {
        for (let i = 0; i < node.declarations.length; i++) {
            collection.push(node.declarations[i].id.name);
        }
    }

    // If the type of the node is FunctionDeclaration or ArrowFunctionExpression
    if (node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression") {
        for (let i = 0; i < node.params.length; i++) {
            collection.push(node.params[i].name);
        }
    }

    // 4. Objects: Do recursion
    for (const value of Object.values(node)) {
        collectVariables(value, collection);
    }

    return collection;
}