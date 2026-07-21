# flowdata

Trace how data flows through a TypeScript/JavaScript codebase, rendered as an interactive graph.

Point it at a project and flowdata parses every file, resolves scope, links uses to declarations across files, and follows values as they flow from one variable into another. Click any symbol to see where it's declared, where it's used, and what it feeds into.

Pain point it solves: As the codebase for my project, Resurface, grew, it eventually became harder for me to create a mental map in my head of all the input/output data. So, I started this project and am actively working on it. 

<!-- ![flowdata graph](./docs/demo.png) -->

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/temal07/flowdata
cd flowdata
bun install
```

## Usage

```bash
flow ./path/to/project
```

flowdata scans for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files, analyzes them, and opens a local graph viewer. Search for a symbol to reveal it and its connections; click a node for its declaration site and every use.

## Where things live

| Path | What's there |
| --- | --- |
| [`src/scripts/`](src/scripts/README.md) | The analysis engine itself — AST walker, CLI, dev utilities. **Start with [`src/scripts/README.md`](src/scripts/README.md)** for a guided tour. |
| [`src/viewer/`](src/viewer) | The static, dependency-free graph viewer (Cytoscape.js) that `flow.ts` serves the graph JSON to. |
| [`src/tests/`](src/tests) | Small fixture files used by the engine's dev utilities (`tree.ts`, `debug.ts`). |
| [`NOTES.md`](NOTES.md) | Living dev notes: feature status, what's implemented per version, known limitations and deferred issues. |

## Testing

```bash
bun test
```

## Status

Early and under active development.

**Works today:** multi-file extraction, scope resolution, cross-file import linking, intraprocedural data-flow edges, and argument → parameter flow across function calls.

**Coming:** return-value flow back to call sites (full interprocedural), method-call resolution (`obj.method()`), use-before-declaration support, and an MCP server for agents.

## Internals

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the project-level architecture — what has been shipped, what is currently being worked on, and future plans — and [`src/scripts/README.md`](src/scripts/README.md) for a code-level deep dive into the engine itself.

## License

MIT
