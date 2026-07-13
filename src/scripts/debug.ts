// A copy of flow.ts but for debugging purposes
// will not interfere with the main branch.

// Exists only for branches where I am working on a new version

import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Binding, Results } from "./types";
import { resolve } from "path";

// CLI setup removed: variable parsing, usage, process.exit, open browser, shutdown on keypress, etc.

// You can now import and use the core logic below programmatically.

export async function analyzeProject(projectDir: string) {
    const glob = new Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");

    const treeResults: Record<string, Results> = {};

    for await (const file of glob.scan(projectDir)) {
        const absolutePath = resolve(projectDir, file);
        const code = await Bun.file(absolutePath).text();
        const tree = parse(code, { loc: true, range: true });
        treeResults[absolutePath] = collectVariables(tree, absolutePath);
    }

    // for each file, for each import declaration, find the real declaration
    // in the source file and move the uses onto it
    for (const fileResults of Object.values(treeResults)) {
        for (const binding of fileResults.declarations) {
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

    // Move the declarations into a flat "nodes" array:
    // every declaration from every file, uses already attached.
    const graph: { nodes: Binding[] } = { nodes: [] };

    for (const fileResults of Object.values(treeResults)) {
        for (const declaration of fileResults.declarations) {
            // skip every non-declaration (use) role
            if (declaration.role !== "declaration") continue;

            // skip every node that has imports
            if (declaration.kind === "import") continue;

            graph.nodes.push(declaration);
        }
    }

    return {
        filesAnalyzed: Object.keys(treeResults).length,
        declarationCount: graph.nodes.length,
        treeResults,
    };
}

console.log(JSON.stringify(await analyzeProject("./"), null, 2));