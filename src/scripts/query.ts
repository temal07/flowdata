#!/usr/bin/env bun
/**
 * query.ts — traversal over a graph.json emitted by flow.ts.
 *
 * Usage: `bun src/scripts/query.ts <declaration-name> [graph.json]`
 *
 * Reads the graph off disk rather than re-running the analysis, so querying
 * is decoupled from the CLI/viewer pipeline: `flow <dir>` produces the graph
 * once (see its step 5), everything here is a pure consumer of that file.
 *
 * The traversal answers "where does this value end up?" by following data
 * flow forward from one declaration:
 *
 *   - Direct flow: an edge A -> B means some use of A fed B (a variable
 *     initializer or a call argument matched to a parameter). Following
 *     outgoing edges walks the value downstream.
 *   - Interprocedural flow: if a function returns the declaration we're
 *     standing on, the value escapes through that function's call sites, so
 *     we hop to the function node and keep following *its* outgoing edges.
 *     `returns` is stamped on function nodes by engine.ts.
 *
 * A visited set keyed by node id keeps cycles (recursion, reassignment
 * loops) from running forever.
 */

import type { Binding } from "./types";
import { relative } from "path";

// Mirrors the shapes flow.ts serializes — kept local because they describe
// the on-disk artifact, not the in-memory analysis model in types.ts.
type GraphNode = Binding & { id: string };
type Occurrence = { file: string; line: number; code: string };
type GraphEdge = { source: string; target: string; occurrences: Occurrence[] };
type Graph = { root: string; nodes: GraphNode[]; edges: GraphEdge[] };

const targetName = Bun.argv[2];
const graphPath = Bun.argv[3] ?? "graph.json";

if (!targetName) {
    console.error("Usage: query <declaration-name> [graph.json]");
    process.exit(1);
}

const file = Bun.file(graphPath);
if (!(await file.exists())) {
    console.error(`query: no graph at ${graphPath} — run \`flow <directory>\` first`);
    process.exit(1);
}

const graph: Graph = await file.json();

if (!Array.isArray(graph.edges)) {
    console.error(`query: ${graphPath} has no edges — it predates the current flow.ts output; regenerate it`);
    process.exit(1);
}

// Index the graph once: id -> node, and id -> the nodes it feeds.
const byId = new Map(graph.nodes.map((node) => [node.id, node]));

const outgoing = new Map<string, GraphEdge[]>();
for (const edge of graph.edges) {
    const edges = outgoing.get(edge.source);
    if (edges) edges.push(edge);
    else outgoing.set(edge.source, [edge]);
}

// Reverse of `returns`: for a declaration id, which functions hand it back
// to their callers. Precomputed so a visit is a lookup instead of a scan
// over every function node in the graph.
const returnedBy = new Map<string, GraphNode[]>();
for (const node of graph.nodes) {
    if (node.kind !== "function" || !node.returns) continue;
    for (const returned of node.returns) {
        const id = `${returned.file}:${returned.start}`;
        const functions = returnedBy.get(id);
        if (functions) functions.push(node);
        else returnedBy.set(id, [node]);
    }
}

/** `file:line` relative to the analyzed project root, for readable output. */
function where(node: GraphNode): string {
    return `${relative(graph.root, node.file)}:${node.line}`;
}

const visited = new Set<string>();

function trace(node: GraphNode, depth: number, note: string) {
    if (visited.has(node.id)) {
        console.log(`${"  ".repeat(depth)}${note}${node.name} (${where(node)}) — already visited`);
        return;
    }
    visited.add(node.id);

    console.log(`${"  ".repeat(depth)}${note}${node.name} [${node.kind}] (${where(node)})`);

    // Direct flow: every declaration this one feeds.
    for (const edge of outgoing.get(node.id) ?? []) {
        const target = byId.get(edge.target);
        if (!target) continue;
        const at = edge.occurrences[0];
        trace(target, depth + 1, at ? `-> via \`${at.code}\` ` : "-> ");
    }

    // Interprocedural flow: the value leaves through the return of any
    // function that hands it back, so continue from that function's own
    // outgoing edges.
    for (const fn of returnedBy.get(node.id) ?? []) {
        trace(fn, depth + 1, "-> returned by ");
    }
}

const starts = graph.nodes.filter((node) => node.name === targetName);

if (starts.length === 0) {
    console.log(`query: no declaration named ${targetName} in ${graphPath}`);
    process.exit(1);
}

if (starts.length > 1) {
    console.log(`query: ${starts.length} declarations named ${targetName}; tracing the first`);
    for (const start of starts) console.log(`  ${where(start)} [${start.kind}]`);
}

trace(starts[0]!, 0, "");
