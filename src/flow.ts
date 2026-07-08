import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";

// Create a Glob Object

const glob = new Glob("**/*.ts");           // ** = all subfolders, *.ts = TypeScript files
const projectDir = import.meta.dir;         // the folder you want to analyze

const testedVariable : string = "limit"
const FILE = `${import.meta.dir}/example.ts`;

const treeResults = {};

for await (const file of glob.scan(projectDir)) {
    const code = await Bun.file(file).text();
    const tree = parse(code, { loc: true, range: true });
    (treeResults as Record<string, unknown>)[file] = collectVariables(tree, `${projectDir}/${file}`);   
}


// loc gives us line numbers, which is off by default in typescript-estree.


/*
    the function collectVariables uses a tree 
    (indicated by the node param) to give ALL 
    declarations and uses of ALL variables.

    getDataFlow is supposed to do the same, but only for the query
    given in the param
*/

function getDataFlow() {
    /* 
        Pseudocode:
        1. given a query, use collectVariables to get the whole tree
        2. Then use the tree to find the name that matches with query
    */

    return treeResults;
}

console.log(JSON.stringify(getDataFlow(), null, 2));