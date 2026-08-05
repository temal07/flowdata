# flowdata — dev notes

Static analysis engine for TypeScript/JavaScript. Parses source into an AST, resolves scope, extracts declarations and uses, links them across files, and traces data flow.

---

## Status

| Feature | State |
| --- | --- |
| Per-file extraction (declarations + uses) | ✅ Done |
| Scope resolution (functions, arrows, blocks) | ✅ Done |
| Cross-file linking (imports → declarations) | ✅ Done — `.ts` only |
| Intraprocedural `feeds` edges (v1.1) | ✅ Done |
| Argument → parameter flow (v1.2) | ✅ Done — direct calls only |
| Return capture (`returns` on function nodes) | ✅ Done |
| Graph output + local viewer (`flow <dir>`) | ✅ Done |
| Query/traversal layer (`query <name>`) | ✅ Done — forward trace |
| Automated tests | ❌ None |
| Method-call resolution | ⏳ Next |
| Two-pass resolution | ⏳ Next |
| MCP wrapper | ⏳ Planned |

---

## What works

Verified by running `collectVariables` on each snippet (August 4, 2026).

**Scope and shadowing.** `const x = 1; function f() { const x = 2; const y = x }` — the inner `x` feeds `y`; the outer `x` is untouched.

**Feed targets nest correctly.** Save/restore around each declarator means `const a = () => { const b = x }` gives `x` feeds `b`, not `a`. Multiple declarators (`const a = 1, b = foo()`) and multiple uses in one init (`const c = x + y`) both resolve to the right target.

**Full interprocedural chain.** `function foo(p) { return p } const z = 2; const a = foo(z)` produces `z` feeds `p`, `foo.returns = [p]`, and `foo` feeds `a`. `query.ts` stitches these into one path — this is the v1.2 goal, and it is done. (The old note saying flow is "intraprocedural only" was stale.)

**Nested calls chain.** `const a = wrap(id(z))` gives `z` feeds `p` (id's param), `id` feeds `q` (wrap's param), `wrap` feeds `a`. The argument walk recurses properly.

---

## Known gaps

Ordered by how much they cost on real code. Each has a snippet that reproduces it.

### 1. Method calls don't reach parameters

`engine.ts` only resolves a call site when `node.callee.type === "Identifier"` — i.e. bare `foo(x)`. For `obj.m(x)` the callee is a `MemberExpression`, so the whole call-site branch is skipped and the arguments fall through to the generic walk.

```ts
class R { score(p) { return p } }
const r = new R(); const z = 1;
const out = r.score(z);   // z feeds `out` directly — never reaches `p`
```

The edge isn't wrong, but the parameter hop is missing, so flow can't be followed into the method body. This is the biggest coverage gap, since most calls in real code are method calls.

Resolving these needs a receiver → declaration answer (what is `r`?), which is real type resolution. A cheaper first cut: match on method name alone, ignoring the receiver — imprecise, but it would fire.

### 2. Uses before their declaration are dropped

A single walk in source order means a declaration must be visited before any use of it. When it isn't, the identifier resolves to nothing and **the use is silently discarded** — no node, no edge, no warning.

```ts
foo(); function foo(p) {}       // `foo` ends up with zero uses
const a = b; const b = 2;       // `b` ends up with zero uses
for (let i = 0; i < 3; i++) { const b = i }   // body's use of `i` lost;
                                              // test/update uses are kept
```

Fix is two-pass resolution: pass 1 walks the tree collecting declarations only, pass 2 walks again resolving uses against the now-complete scopes. The hard part is carrying each scope's pass-1 declarations into pass 2 — the scope stack is rebuilt on the second walk, so scopes need stable identity (node range works) to look up what pass 1 found.

### 3. Classes, methods, types, and catch params are never resolvable

`ClassDeclaration`, `MethodDefinition`, `CatchClause`, and the TS declarations (`enum`/`interface`/`type`) push straight into `results.declarations` instead of onto the scope stack. They become nodes in the graph, but the identifier lookup only searches the scope stack — so no use ever resolves to them.

```ts
class R {} const r = new R();          // R: 0 uses
type Result = {...}; const x: Result   // Result: 0 uses
try {} catch (err) { const e = err }   // err: 0 uses
```

Fix is small for classes, methods, and catch params: push them onto the current scope like every other binding.

Types are the exception — the walk also returns early on `TSTypeAnnotation` by design, to keep annotations out of the graph. So the scope-stack fix alone won't make `const x: Result` resolve; that needs a separate decision about whether type references belong in a data-flow graph at all.

### 4. Destructuring only binds the last name

`VariableDeclarator` takes "the last declaration in the current scope" as its feed target, so a pattern that binds several names only stamps one.

```ts
const { a, b } = foo();   // foo feeds `b`; `a` gets nothing
```

### 5. Reassignment isn't tracked

Only `const`/`let`/`var` initializers set a feed target. A bare `AssignmentExpression` sets nothing.

```ts
let x; x = foo();   // no edge at all
```

### 6. Shorthand properties produce duplicate uses

In `{ z }` the property's key and value are the same identifier, and the generic walk visits both.

```ts
const z = 1; const o = { z };   // z gets two identical uses, same offset
```

`returns` is deduped (commit c39c185) but `uses` is not, so this inflates the `occurrences` list on the resulting edge.

### 7. Import resolution assumes `.ts`

The resolver appends `.ts` unconditionally, so pure-JS projects extract fine but never link. Directory imports (`./foo` → `./foo/index.ts`) and explicit extensions (`./foo.js` → `./foo.js.ts`) also fail. Fix: try a candidate list of extensions and index files.

---

## Next up

1. **Test harness** — no automated tests exist today; `src/tests/example.ts` is a fixture, not a test. Everything above was verified by hand and by reading output, which is why this file drifted out of sync with the code. Blocking issue: `flow.ts` does linking, graph assembly, and serving at module scope, so there's no function to call — extract `analyze(dir) → Graph` first.
2. **Scope-stack fix for classes/types/catch** (gap 3) — smallest real win, unblocks a whole category of nodes.
3. **Two-pass resolution** (gap 2) — invasive rewrite of the core walk. Do it after the harness exists, not before.
4. **Method-call resolution** (gap 1) — biggest coverage win, most design work.
5. **MCP wrapper** — serve the graph to agents once coverage is trustworthy.

Worth measuring before picking between 3 and 4: on a real repo, what fraction of uses resolve and what fraction of call sites resolve. That turns the ordering above from a guess into a number.

---

*Last updated: August 4, 2026*
