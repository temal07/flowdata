# Architecture

How flowdata analyzes a codebase, from source files to a data-flow graph.

## Project status

### Shipped and working

- **Multi-file extraction** — scans a directory for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files and extracts every declaration (variables, functions, parameters, classes, methods, imports, and TypeScript types), including destructuring patterns.
- **Scope resolution** — a scope stack handles functions, arrow functions, and blocks, so same-named variables in different scopes stay distinct and shadowing resolves correctly.
- **Cross-file import linking** — a post-pass resolves local imports to their source files and connects uses to the real declaration; package imports are treated as external boundaries.
- **Intraprocedural data-flow (`feeds`) edges** — records when a value flows into a declaration (`const a = foo()` → `foo` "feeds" `a`), with the flow target cleared at function boundaries so edges mean exactly "flows into this declaration."
- **Argument → parameter flow** — at a direct call site, arguments are traced into the called function's parameters (`foo(z)` → `z` feeds `p`).
- **Interactive graph viewer** — a local, search-to-reveal graph that stays readable on large codebases.
- **Correct classification of arrow functions** — `const f = () => {}` is treated as a function, not a variable.
- **Return → call-site flow** — tracing a function's return value back to whatever each caller assigns it to. This completes full interprocedural data flow: chaining argument → parameter → return → call site so a value can be followed all the way through a function (`z → p → return → a`).

- **Query and traversal layer** — `query <name>` reads the emitted `graph.json` and traces a declaration forward through `feeds` edges and function returns, so the graph is consumable without re-running the analysis.

### In progress

- **Test harness** — the project has no automated tests; correctness has been verified by reading output. See `NOTES.md` for the gaps this has allowed to go unnoticed.

### Future goals

- **Scope-stack fix for classes, methods, types, and catch params** — these are emitted as nodes but never pushed onto the scope stack, so no use can resolve to them.
- **Method-call resolution** — handle `obj.method()` call sites, not just direct calls, so interprocedural flow fires on the majority of real-world calls.
- **Two-pass resolution** — resolve uses that appear before their declaration in source order (function hoisting, forward references, some loop constructs).
- **Complete JS import resolution** — resolve imports across extensions and index files rather than assuming `.ts`.
- **MCP server** — expose the graph to AI agents so they can query a codebase's data flow directly.
- **Multi-language support** — additional language extractors emitting the same neutral declaration format, so the graph, linking, and query layers work unchanged across languages.

## Overview

flowdata runs a single recursive walk over each file's AST (produced by `@typescript-eslint/typescript-estree`), building per-file results keyed by absolute path. Each declaration is identified by `{ file, start }` — a unique coordinate across the whole project, so edges can point at specific nodes.

## Scope resolution

A stack of scopes is pushed and popped as the walk enters and leaves functions, arrow functions, and blocks. Declarations are added to the current scope; uses resolve to the nearest matching declaration by searching the stack top-down. This keeps two same-named variables in different scopes distinct and makes shadowing resolve correctly.

Node identity is `{ file, start }` (the character offset), which uniquely locates any declaration or use.

## Cross-file linking

After every file has been walked, a separate linking pass runs. For each local import, it resolves the import source to an absolute file path, finds the real declaration in that file, and moves the import's uses onto it. Package imports (bare specifiers like `react`) are treated as external boundaries and left unlinked. Running this as a post-pass avoids ordering problems — every file's declarations exist before any linking is attempted.

## Data-flow edges (`feeds`)

A `feeds` edge on a use records the declaration a value flows into.

The mechanism is a single "current flow target" that is set as the walk enters a declaration's initializer and restored as it leaves. Any use created while a target is set is stamped with a `feeds` edge pointing at that target's identity. Save/restore around each declarator makes nesting correct — an inner declaration temporarily becomes the target and the outer one is restored afterward.

The target is cleared at function boundaries, so a `feeds` edge means precisely "this value flows into that declaration," not merely "this value is used somewhere inside that function."

## Argument → parameter flow

A function's binding carries its parameters (by identity), for both `function foo(p) {}` and `const foo = (p) => {}` forms.

At a call site with a direct (identifier) callee, the callee is resolved against the scope stack to find the function's binding. Each argument is then walked with the corresponding parameter set as the flow target, so a value passed into a call is traced into the parameter it lands in. Arguments beyond the parameter list are still walked, with no target.

Because arguments are walked recursively, nested calls chain: in `wrap(id(z))`, `z` feeds `id`'s parameter and `id` feeds `wrap`'s parameter.

Only identifier callees are resolved. A method call (`obj.m(x)`) falls through to the generic walk, so its arguments are stamped with whatever flow target is already active — usually the declaration the call result is assigned to. The edge is real, but the hop into the method's parameters is missing.

## Return → call-site flow

The walk tracks two extra pieces of state: the function it is currently inside, and whether it is inside a `ReturnStatement`. When an identifier resolves while both hold, the identity of the resolved declaration is appended to the enclosing function's `returns` array (deduplicated by `{ file, start }`).

That gives each function node a list of what it hands back. The call site half already exists — `const a = foo()` records `foo` feeding `a` — so joining them completes the chain: `z → p` (argument to parameter), `p ∈ foo.returns`, `foo → a` (call result to assignment). `query.ts` builds the reverse index of `returns` once at startup, so tracing a value can hop from a declaration to every function that returns it and continue from that function's outgoing edges.

## Output

Per-file results are flattened into a node list for the graph viewer. Each node is a declaration carrying its uses and flow edges; the viewer renders nodes on demand (search-to-reveal) so the graph stays readable on large codebases.

## Known limitations

Full detail, with reproducing snippets, is in `NOTES.md`.

- Call resolution handles direct calls (`foo(x)`); method calls (`obj.foo(x)`) do not reach the method's parameters.
- The single-pass walk cannot resolve a use that appears before its declaration in source order (function hoisting, forward references, loop bodies). The use is dropped silently — no node, no edge, no warning.
- Classes, class methods, TS type declarations, and catch parameters are recorded as nodes but never pushed onto the scope stack, so no use ever resolves to them.
- A destructuring declaration only takes its last bound name as the flow target: `const { a, b } = foo()` gives `foo → b` and nothing for `a`.
- Only declaration initializers set a flow target; reassignment (`x = foo()`) produces no edge.
- Shorthand object properties (`{ z }`) record the same use twice, inflating an edge's occurrence list.
- Cross-file linking appends `.ts` unconditionally, so pure-JS projects, directory imports, and explicit extensions do not link.
