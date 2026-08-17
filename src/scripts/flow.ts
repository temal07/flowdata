#!/usr/bin/env bun
/**
 * flow.ts — the `vena` CLI.
 *
 * Usage: `vena <directory>`
 *
 * This file is the "productionized" counterpart to debug.ts: same pipeline,
 * but as a real CLI (argv parsing, process.exit, browser launch, graceful
 * shutdown on `q`/Ctrl+C) instead of a programmatic entry point.
 */
import { resolve } from "path";
import { analyse } from "./analyse";

const USAGE =
    "vena — map how data flows through a TypeScript/JavaScript project.\n" +
    "\n" +
    "Analyses every source file, links uses to declarations across files, writes the\n" +
    "graph to disk, and opens a local viewer.\n" +
    "\n" +
    "Usage: vena <directory> [output.json]\n" +
    "  <directory>    project to analyse — scans .ts .tsx .js .jsx .mjs .cjs\n" +
    "  [output.json]  where to write the graph (default: ./graph.json)\n" +
    "\n" +
    "Then trace individual values with `vena-trace <target> [graph.json] --back`.";

const targetArg = Bun.argv[2];

// Handled before the empty check so `--help` prints on stdout and exits 0. It
// used to fall through to `resolve()` and die on an ENOENT stack trace, which
// is the first thing a new user types.
if (targetArg === "--help" || targetArg === "-h") {
    console.log(USAGE);
    process.exit(0);
}

if (!targetArg) {
    console.error(USAGE);
    process.exit(1);
}

const projectDir = resolve(process.cwd(), targetArg);

const { graph, filesAnalysed, skipped, unlinkedImports } = await analyse(projectDir);
// Serialized once and used twice: written to disk below, and served verbatim
// to the viewer. Left compact deliberately — indenting this graph costs ~45%
// more bytes (16.2MB vs 11.2MB on this repo) on both paths, and nothing reads
// it by eye. Use `jq . graph.json` when you do need to.
const graphJson = JSON.stringify(graph);

// Write the graph to a JSON file.
const outPath = resolve(process.cwd(), Bun.argv[3] ?? "graph.json");
await Bun.write(outPath, graphJson);
console.log(`vena: analysed ${filesAnalysed} files.`);
// Every skipped file is a hole in the graph. Saying so here is the whole point
// of collecting them — a graph that is quietly missing a file looks exactly
// like a graph where that file had nothing to contribute. First few only, since
// a broken directory can produce hundreds and the pattern shows in the first
// three.
if (skipped.length > 0) {
    console.log(`vena: skipped ${skipped.length} file(s) that failed to parse:`);
    for (const { file, reason } of skipped.slice(0, 3)) {
        console.log(`  ${file.replace(projectDir + "/", "")} — ${reason}`);
    }
    if (skipped.length > 3) console.log(`  ...and ${skipped.length - 3} more`);
}

// The same argument as the skipped block above, one level down: a missing
// cross-file edge is indistinguishable from two things that genuinely never
// touched. Counted per specifier, and only local imports — `from "zod"` is
// outside the project and skipping it is correct, so it is not in this number.
if (unlinkedImports > 0) {
    console.log(`vena: ${unlinkedImports} import specifier(s) point inside the project ` +
        `but could not be linked — those edges are missing from the graph.`);
}

// Gap 18: the inferred share is the one number here that bounds how wrong the
// graph can be. Every other edge is proven; these passed through a call whose
// callee never resolved, so they are assumed. Said out loud rather than left in
// the JSON, because a graph that silently mixes the two is a graph you can't
// cite. `vena-trace --strict` traverses without them.
const inferredEdges = graph.edges.filter((e) => e.inferred).length;
if (inferredEdges > 0) {
    const share = ((inferredEdges / graph.edges.length) * 100).toFixed(1);
    console.log(`vena: ${graph.edges.length} edges — ${graph.edges.length - inferredEdges} proven, ` +
        `${inferredEdges} inferred (${share}%) through unresolved calls.`);
}

console.log(`vena: wrote graph to ${outPath}`);

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

console.log(`vena: serving graph viewer at ${server.url}`);

const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
Bun.spawn([openCommand, server.url.toString()], { stdout: "ignore", stderr: "ignore" });

console.log("vena: press q + Enter to stop (or Ctrl+C)");

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