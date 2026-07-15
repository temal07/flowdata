#!/usr/bin/env bun
import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Binding, Results } from "./types";
import { resolve } from "path";

const targetArg = Bun.argv[2];

if (!targetArg) {
    console.error("Usage: flow <directory>");
    process.exit(1);
}

const projectDir = resolve(process.cwd(), targetArg);
const glob = new Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");

const treeResults: Record<string, Results> = {};
// keep each file's source around so edge clicks can show the actual code
// at the use site, not just a file:line reference.
const fileTexts: Record<string, string> = {};

for await (const file of glob.scan(projectDir)) {
    const absolutePath = resolve(projectDir, file);
    const code = await Bun.file(absolutePath).text();
    const tree = parse(code, { loc: true, range: true });
    treeResults[absolutePath] = collectVariables(tree, absolutePath);
    fileTexts[absolutePath] = code;
}

function codeAt(file: string, line: number): string {
    return fileTexts[file]?.split("\n")[line - 1]?.trim() ?? "";
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

// A declaration's file+start is unique, so it doubles as a stable node id
// for edges (feeds targets are stamped with the same file+start).
function nodeId(file: string, start: number): string {
    return `${file}:${start}`;
}

// Move the declarations into a flat "nodes" array:
// every declaration from every file, uses already attached.
type GraphNode = Binding & { id: string };
type Occurrence = { file: string; line: number; code: string };
type GraphEdge = { source: string; target: string; occurrences: Occurrence[] };
const graph: { root: string; nodes: GraphNode[]; edges: GraphEdge[] } = { root: projectDir, nodes: [], edges: [] };

for (const fileResults of Object.values(treeResults)) {
    for (const declaration of fileResults.declarations) {
        // skip every non-declaration (use) role
        if (declaration.role !== "declaration") continue;

        // skip every node that has imports
        if (declaration.kind === "import") continue;

        graph.nodes.push({ ...declaration, id: nodeId(declaration.file, declaration.start) });
    }
}

// Read the feeds stamped on each use: the use's owning declaration is the
// thing being used, and use.feeds names the declaration that use flows into.
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

const viewerDir = new URL("../viewer/", import.meta.url).pathname;
const graphJson = JSON.stringify(graph);

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
