#!/usr/bin/env bun
/**
 * trace.ts — watch the engine walk a snippet, one step at a time.
 *
 * Usage:
 *   bun run src/scripts/trace.ts <path/to/file>
 *   bun run src/scripts/trace.ts          # runs the built-in example
 *
 * Where tree.ts shows you the *shape* the parser produced, this shows you
 * what `collectVariables` (engine.ts) actually *did* with it: every name it
 * filed, every name it looked up, every scope it opened and closed. It is the
 * tool to reach for when the engine's behaviour stops matching your mental
 * model — run it on five lines and read what happened, rather than simulating
 * four mutable module variables in your head.
 *
 * The engine reports these events through `setTraceHook`; that hook is null
 * in every normal run, so nothing here is in the `flow` CLI's path.
 *
 * Reading the output:
 *   DECLARE  a name was filed in the current scope, and can now be found
 *   RESOLVE  a name was looked up and matched to its declaration
 *   defer    a name was looked up and found nothing — set aside for later
 *   skip     the identifier IS the declaration, so it isn't a use of itself
 *   FEED     anything used from here until "done" flows into the named thing
 *   SCOPE    a scope opened or closed
 */

import { parse } from "@typescript-eslint/typescript-estree";
import { collectVariables, setTraceHook, type TraceEvent } from "./engine";

const FILE = `${import.meta.dir}/../tests/example.ts`;

const snippet = await Bun.file(Bun.argv[2] ?? FILE).text();

// Collect first, print after: the walk should not be interleaved with output.
const events: TraceEvent[] = [];
setTraceHook((event) => events.push(event));

const ast = parse(snippet, { loc: true, range: true });
const results = collectVariables(ast, "/snippet.ts");

setTraceHook(null);   // leave the engine as we found it

/**
 * A ruler under the source, so the offsets in the trace point at something
 * you can see. An offset is just "how many characters from the start of the
 * file", which is what makes it a unique id for a declaration.
 */
function ruler(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i += 10) out = out.padEnd(i, " ") + String(i);
    return out;
}

const LABEL: Record<string, string> = {
    declare: "DECLARE",
    resolve: "RESOLVE",
    defer: "defer",
    skip: "skip",
    feed: "FEED",
    scope: "SCOPE",
    phase: "——",
};

console.log(`\nsource:  ${snippet}`);
console.log(`offset:  ${ruler(snippet)}\n`);

for (const event of events) {
    const label = (LABEL[event.kind] ?? event.kind).padEnd(8);
    console.log(`  ${"  ".repeat(event.depth)}${label} ${event.detail}`);
}

// What the walk actually produced, so the trace can be checked against it.
console.log(`\nresult:`);
for (const declaration of results.declarations) {
    const uses = declaration.uses.length === 0
        ? "no uses"
        : `${declaration.uses.length} use(s) at offset ${declaration.uses.map(u => u.start).join(", ")}`;
    console.log(`  ${declaration.name} (${declaration.kind}) declared at offset ${declaration.start} — ${uses}`);
}

const edges: string[] = [];
for (const declaration of results.declarations) {
    for (const use of declaration.uses) {
        for (const fed of use.feeds ?? []) edges.push(`${declaration.name} -> ${fed.name}`);
    }
}
console.log(`\nedges:   ${edges.length ? edges.sort().join(", ") : "(none)"}\n`);
