/**
 * tree.ts — dev utility: dump the raw AST for `src/tests/example.ts`.
 *
 * Not part of the analysis pipeline (engine.ts doesn't run here) — this
 * bypasses `collectVariables` entirely and prints the parser's output
 * directly, which is useful when adding a new node-type case to
 * `walkVariables` and you need to see the exact shape TSESTree gives you.
 *
 * Run with `bun run src/scripts/tree.ts`.
 */
import { parse } from "@typescript-eslint/typescript-estree";
import { collectVariables } from "./engine";

const FILE = `${import.meta.dir}/../tests/example.ts`;
const code = await Bun.file(FILE).text();

const tree = parse(code, { loc: true });
console.log(JSON.stringify(tree, null, 2));
