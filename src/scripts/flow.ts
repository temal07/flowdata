#!/usr/bin/env bun
/**
 * flow.ts — the `flow` CLI.
 *
 * Usage: `flow <directory>`
 *
 * End-to-end pipeline:
 *   1. Glob every source file under the target directory and parse + walk
 *      each one with `collectVariables` (engine.ts), collecting one
 *      `Results` per file.
 *   2. Resolve imports: for every "import" binding, find the real
 *      declaration it points at in the imported file's `Results` and merge
 *      the import's uses onto that real declaration. After this step,
 *      import bindings themselves are dead weight (skipped in step 3).
 *   3. Flatten every file's declarations into one `nodes` array — this is
 *      the graph's vertex set. Each node keeps its accumulated `uses`.
 *   4. Turn `Use.feeds` pointers into graph edges: for every use that feeds
 *      a declaration, draw an edge from the use's *owning* declaration to
 *      the *fed* declaration, deduping by (source, target) pair and
 *      collecting every contributing use as an `occurrences` entry (so the
 *      viewer can show the actual source line when an edge is clicked).
 *   5. Serve the graph as JSON alongside the static viewer (src/viewer/)
 *      over a local HTTP server, and open it in the default browser.
 *
 * This file is the "productionized" counterpart to debug.ts: same pipeline,
 * but as a real CLI (argv parsing, process.exit, browser launch, graceful
 * shutdown on `q`/Ctrl+C) instead of a programmatic entry point.
 */
import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Graph, GraphEdge, Results } from "./types";
import { resolve } from "path";

const targetArg = Bun.argv[2];

if (!targetArg) {
    console.error("Usage: flow <directory>");
    process.exit(1);
}

const projectDir = resolve(process.cwd(), targetArg);
const glob = new Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");

// Directories that are never the user's own source. Without this a plain
// `flow .` walks node_modules and parses every dependency — in this repo
// that's 496 of 505 matched files, and the resulting graph runs to gigabytes.
const IGNORED_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor",
]);

/** Whether a path (relative to `projectDir`) is project source worth walking. */
function isProjectSource(relativePath: string): boolean {
    if (relativePath.split("/").some((segment) => IGNORED_DIRS.has(segment))) return false;
    // Ambient type declarations: no runtime values, so no data flow to trace,
    // and they're the bulk of what ships inside packages.
    if (relativePath.endsWith(".d.ts")) return false;
    return true;
}

// Step 1: parse + walk every file in the project.
const treeResults: Record<string, Results> = {};
// keep each file's source around so edge clicks can show the actual code
// at the use site, not just a file:line reference.
const fileTexts: Record<string, string> = {};

for await (const file of glob.scan(projectDir)) {
    // disregards non-project source files 
    // specified in the isProjectSource function
    if (!isProjectSource(file)) continue;
    // resolves the absolute path of the file
    const absolutePath = resolve(projectDir, file);
    // reads the file's text content
    const code = await Bun.file(absolutePath).text();
    // parses the file's code into an AST
    const tree = parse(code, { loc: true, range: true });
    // collects the variables in the AST
    // and stores the results in the treeResults object
    // format: {"some path": Results}
    treeResults[absolutePath] = collectVariables(tree, absolutePath);
    // stores the file's text content
    fileTexts[absolutePath] = code;
}

/** Longest snippet stored per edge occurrence. A minified file is a handful
 *  of lines hundreds of kilobytes wide (cytoscape.min.js: 33 lines, longest
 *  229k chars); storing one verbatim per edge is what turned a 9-file graph
 *  into 1.1GB of JSON. The viewer only renders a single line anyway. */
const MAX_SNIPPET = 200;

/** Lines per file, split once — `codeAt` is called for every occurrence of
 *  every edge, and re-splitting a large source each time is not free. */
const fileLines: Record<string, string[]> = {};

/** The source line (trimmed, truncated) at `file:line`, for edge-click display. */
function codeAt(file: string, line: number): string {
    const lines = (fileLines[file] ??= fileTexts[file]?.split("\n") ?? []);
    const text = lines[line - 1]?.trim() ?? "";
    return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
}

// Step 2: for each file, for each import declaration, find the real
// declaration in the source file and move the uses onto it.
for (const fileResults of Object.values(treeResults)) {
    for (const binding of fileResults.declarations) {
        // disregard non-import bindings
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

// A declaration's file+start is unique, so it doubles as a stable node id
// for edges (feeds targets are stamped with the same file+start).
function nodeId(file: string, start: number): string {
    return `${file}:${start}`;
}

// Step 3: move the declarations into a flat "nodes" array:
// every declaration from every file, uses already attached.
const graph: Graph = { root: projectDir, nodes: [], edges: [] };

for (const fileResults of Object.values(treeResults)) {
    for (const declaration of fileResults.declarations) {
        // skip every non-declaration (use) role
        if (declaration.role !== "declaration") continue;

        // skip every node that has imports
        if (declaration.kind === "import") continue;

        graph.nodes.push({ ...declaration, id: nodeId(declaration.file, declaration.start) });
    }
}

// Step 4: read the feeds stamped on each use: the use's owning declaration is
// the thing being used, and use.feeds names the declaration that use flows into.
// Draw an edge owning declaration -> fed declaration for each one, keeping
// every use site that contributed to it so clicking the edge can show the code.
const nodeIds = new Set(graph.nodes.map((n) => n.id));
const edgesByKey = new Map<string, GraphEdge>();
for (const node of graph.nodes) {
    for (const use of node.uses) {
        if (!use.feeds) continue;
        const target = nodeId(use.feeds.file, use.feeds.start);
        // the fed declaration may have been filtered out (e.g. an import);
        // only keep edges where both ends are real graph nodes.
        if (!nodeIds.has(target)) continue;

        const key = `${node.id}->${target}`;
        let edge = edgesByKey.get(key);
        if (!edge) {
            edge = { source: node.id, target, occurrences: [] };
            edgesByKey.set(key, edge);
        }
        edge.occurrences.push({ file: use.file, line: use.line, code: codeAt(use.file, use.line) });
    }
}
graph.edges.push(...edgesByKey.values());

console.log(`flow: analyzed ${Object.keys(treeResults).length} files, found ${graph.nodes.length} declarations, ${graph.edges.length} feeds edges`);

// Step 5: serve the graph JSON + the static viewer (src/viewer/), and open it.
const graphJson = JSON.stringify(graph);

// Write the graph to a JSON file.
const outPath = resolve(process.cwd(), Bun.argv[3] ?? "graph.json");
await Bun.write(outPath, graphJson);
console.log(`flow: wrote graph to ${outPath}`)

// Serve the graph viewer and the graph JSON file. and open it in the browser.
const viewerDir = new URL("../viewer/", import.meta.url).pathname;

const viewerFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/app.js": "app.js",
    "/lib/cytoscape.min.js": "lib/cytoscape.min.js",
};

const server = Bun.serve({
    port: 0,
    fetch(req) {
        const { pathname } = new URL(req.url);

        if (pathname === "/graph.json") {
            return new Response(graphJson, { headers: { "Content-Type": "application/json" } });
        }

        const rel = viewerFiles[pathname];
        if (rel) {
            return new Response(Bun.file(viewerDir + rel));
        }

        return new Response("Not found", { status: 404 });
    },
});

console.log(`flow: serving graph viewer at ${server.url}`);

const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
Bun.spawn([openCommand, server.url.toString()], { stdout: "ignore", stderr: "ignore" });

console.log("flow: press q + Enter to stop (or Ctrl+C)");

function shutdown() {
    server.stop();
    process.exit(0);
}

process.stdin.on("data", (data) => {
    const input = data.toString().trim().toLowerCase();
    if (input === "q" || input === "quit" || input === "exit") {
        shutdown();
    }
});

process.on("SIGINT", shutdown);
