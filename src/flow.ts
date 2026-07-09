import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Binding, Results } from "./types";
import { resolve } from "path"; 

// Create a Glob Object

const glob = new Glob("**/*.ts");           // ** = all subfolders, *.ts = TypeScript files
const projectDir = import.meta.dir;         // the folder you want to analyze

const testedVariable : string = "limit"

// An object to store the tree with a string key 
// and a Results value
const treeResults : Record<string, Results> = {};

for await (const file of glob.scan(projectDir)) {
    const code = await Bun.file(file).text();
    const tree = parse(code, { loc: true, range: true });
    const absolutePath = resolve(projectDir, file);
    (treeResults as Record<string, Results>)[absolutePath] = collectVariables(tree, `${projectDir}/${file}`);   
}

console.log(Object.keys(treeResults));

// for each file, for each import declaration, find the real declaration
// in the source file and move the uses onto it
for (const fileResults of Object.values(treeResults) as Results[]) {   // each is a Results object
    for (const binding of fileResults.declarations) {      // reach into .declarations
        // only deal with imports
        if (binding.kind !== "import") continue;

        // assign the source of the import
        const sourceResults = treeResults[binding.source!];

        // for undefined values of sourceResults, which are due to
        // packages and dependencies being imported, simply skip them
        if (sourceResults === undefined) continue;

        const realDec = sourceResults.declarations.find(
            param => param.name === binding.name && param.kind !== "import"
        );

        if (!realDec) continue;
        realDec.uses.push(...binding.uses);
    }
}

console.log(JSON.stringify(treeResults, null, 2));

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

//console.log(JSON.stringify(getDataFlow(), null, 2));