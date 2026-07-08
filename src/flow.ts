import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";

// Create a Glob Object

const glob = new Glob("**/*.ts");           // ** = all subfolders, *.ts = TypeScript files
const projectDir = import.meta.dir;         // the folder you want to analyze

for await (const file of glob.scan(projectDir)) {
    console.log(file);                       // each .ts file path, one at a time
}

const FILE = `${import.meta.dir}/example.ts`;
const code = await Bun.file(FILE).text();

// loc gives us line numbers, which is off by default in typescript-estree.
const tree = parse(code, { loc: true, range: true });

const testedVariable : string = "limit"

/*
    the function collectVariables uses a tree 
    (indicated by the node param) to give ALL 
    declarations and uses of ALL variables.

    getDataFlow is supposed to do the same, but only for the query
    given in the param
*/

function getDataFlow(query: unknown) {
    /* 
        Pseudocode:
        1. given a query, use collectVariables to get the whole tree
        2. Then use the tree to find the name that matches with query
    */

    const results = collectVariables(tree);

    return JSON.stringify(results.declarations.filter(d => d.name === query), null, 2);
}

console.log(`${testedVariable}`, getDataFlow(`${testedVariable}`));
