/**
 * debug.ts — programmatic, no-CLI mirror of flow.ts for local iteration.
 *
 * A copy of flow.ts's parse-and-link pipeline (steps 1-3: walk every file,
 * resolve imports onto their real declaration, flatten into a node list)
 * with everything CLI/server-shaped stripped out — no argv parsing, no
 * feeds-edge construction, no viewer, no `process.exit`/browser-open/
 * shutdown-on-keypress. Exists so a new engine.ts feature can be exercised
 * against `../tests` (or any directory, via `analyzeProject`) with a plain
 * `bun run` and a JSON dump, without spinning up the graph viewer.
 *
 * Kept deliberately out of the `flow` CLI's path (see `bin` in
 * package.json) so changes here can't affect the shipped command.
 */

import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Binding, Results } from "./types";
import { resolve } from "path";

// the directory the debug.ts is gonna work in.
const dirToAnalyse : string = "../tests";

/**
 * Walk every source file under `projectDir`, resolve imports to their real
 * declarations, and flatten the result into a node list.
 *
 * Same first three steps as flow.ts's top-level pipeline, minus the
 * feeds-edge / viewer / CLI machinery — see the module doc above.
 */
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

console.log(JSON.stringify(await analyzeProject(dirToAnalyse), null, 2));
// console.log(JSON.stringify(await analyzeProject("../../../../Desktop/resurface/src/utils"), null, 2));
