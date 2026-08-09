# flowdata — dev notes

Static analysis engine for TypeScript/JavaScript. Parses source into an AST, resolves scope, extracts declarations and uses, links them across files, and traces data flow.

---

## Status


| Feature                                      | State                                |
| -------------------------------------------- | ------------------------------------ |
| Per-file extraction (declarations + uses)    | ✅ Done                               |
| Scope resolution (functions, arrows, blocks) | ✅ Done                               |
| Cross-file linking (imports → declarations)  | ✅ Done — `.ts` only                  |
| Intraprocedural `feeds` edges (v1.1)         | ✅ Done                               |
| Argument → parameter flow (v1.2)             | ✅ Done — direct and method calls     |
| Return capture (`returns` on function nodes) | ✅ Done                               |
| Graph output + local viewer (`flow <dir>`)   | ✅ Done                               |
| Query/traversal layer (`query <name>`)       | ✅ Done — forward trace               |
| Automated tests                              | ⏳ Partial — `bun test`, engine only  |
| Method-call resolution                       | ✅ Done — name-only, receiver ignored |
| Two-pass resolution                          | ⏳ Next                               |
| MCP wrapper                                  | ⏳ Planned                            |


---

## What works

Most of these are guarded by `bun test` (`src/tests/engine.test.ts`); the rest were checked by reading `collectVariables` output.

**Scope and shadowing.** `const x = 1; function f() { const x = 2; const y = x }` — the inner `x` feeds `y`; the outer `x` is untouched.

**Feed targets nest correctly.** Save/restore around each declarator means `const a = () => { const b = x }` gives `x` feeds `b`, not `a`. Multiple declarators (`const a = 1, b = foo()`) and multiple uses in one init (`const c = x + y`) both resolve to the right target.

**Full interprocedural chain.** `function foo(p) { return p } const z = 2; const a = foo(z)` produces `z` feeds `p`, `foo.returns = [p]`, and `foo` feeds `a`. `query.ts` stitches these into one path — this is the v1.2 goal, and it is done. (The old note saying flow is "intraprocedural only" was stale.)

**Nested calls chain.** `const a = wrap(id(z))` gives `z` feeds `p` (id's param), `id` feeds `q` (wrap's param), `wrap` feeds `a`. The argument walk recurses properly.

**Method calls reach parameters.** `class R { score(p) { return p } } const r = new R(); const out = r.score(z)` gives `z` feeds `p`. Works for `this.m(x)` and private `this.#m(x)` too. See the caveats in gap 1 below.

**Classes and catch params resolve.** `class R {} const r = R` gives `R` feeds `r`; `try {} catch (err) { const e = err }` gives `err` feeds `e`.

**Property keys aren't mistaken for references.** `const o = { a: b }` records a use of `b` only; the key `a` is a label, even when a variable named `a` is in scope. `{ z }` records one use, not two. Computed keys still resolve: `{ [k]: v }` records both `k` and `v`.

---

## Known gaps

Ordered by how much they cost on real code. Each has a snippet that reproduces it. **Numbering is stable** — resolved entries stay in place rather than being renumbered, because `src/tests/engine.test.ts` refers to them by number.

### 1. Method calls don't reach parameters — ✅ RESOLVED

The call-site branch used to be gated on `node.callee.type === "Identifier"`, so `obj.m(x)` was skipped entirely. It now also accepts a non-computed `MemberExpression` callee and reads the name from `callee.property.name`. Methods additionally get their `params` and `returns` populated: `MethodDefinition` points `currentFeedTarget` at the method's binding before walking its (always anonymous) `FunctionExpression`, which is how `const f = () => {}` has always worked.

Three things this deliberately does **not** do:

- **The receiver is ignored.** Resolution is by method name only — `b.score(z)` never checks what `b` is. With two same-named methods in scope, `.find()` takes the first, which can be the wrong class. Decided (August 9, 2026) to keep it: the alternative is real type inference, and without name-only matching there are no method edges at all. Revisit if measurement says the collision rate is high.
- **Computed forms are skipped.** `r[k](z)` and `class R { [name]() {} }` have no statically-known name — the identifier there names a *variable holding* the name, so reading it would silently produce a wrong answer. Both bail out on `computed === true`.
- **Unresolvable member calls now emit no argument edge.** Previously `a.b.c(z)` fell through and `z` picked up the ambient feed target, giving a coarse `z → out`. Now the branch fires, finds nothing, and sets the target to null. This matches how unresolved *plain* calls have always behaved, but it does drop argument edges for object-literal methods and built-ins (`arr.map(fn)`, `str.split(sep)`).

### 2. Uses before their declaration are dropped

A single walk in source order means a declaration must be visited before any use of it. When it isn't, the identifier resolves to nothing and **the use is silently discarded** — no node, no edge, no warning.

```ts
foo(); function foo(p) {}       // `foo` ends up with zero uses
const a = b; const b = 2;       // `b` ends up with zero uses
for (let i = 0; i < 3; i++) { const b = i }   // body's use of `i` lost;
                                              // test/update uses are kept
```

Fix is two-pass resolution: pass 1 walks the tree collecting declarations only, pass 2 walks again resolving uses against the now-complete scopes. The hard part is carrying each scope's pass-1 declarations into pass 2 — the scope stack is rebuilt on the second walk, so scopes need stable identity (node range works) to look up what pass 1 found.

### 3. Classes, methods, types, and catch params are never resolvable — ✅ RESOLVED for classes/methods/catch

These four used to push straight into `results.declarations` instead of onto the scope stack. They became nodes in the graph, but the identifier lookup only searches the scope stack, so no use ever resolved to them. All four now push onto the current scope like every other binding, and classes, methods, and catch params resolve.

One wrinkle worth knowing: there is no scope for a class body (`ClassBody` isn't a `BlockStatement`), so a method name lands in the scope *enclosing* the class. That isn't lexically correct — `score` is a property of `R`, not a name in the surrounding scope — but it's what makes `r.score(z)` resolve at all, and it's the same imprecision as gap 1's ignored receiver.

**Types are still open.** The walk returns early on `TSTypeAnnotation` by design, to keep annotations out of the graph, so the scope-stack change alone doesn't make `const x: Result` resolve. That needs a separate decision about whether type references belong in a data-flow graph at all.

```ts
type Result = {...}; const x: Result   // Result: still 0 uses
```

Related, fixed alongside: `makeBinding` used to read `idNode.name` unconditionally, producing a nameless binding for literal keys like `class R { "my-method"() {} }`. It now falls back to `String(idNode.value)`, matching `makeUse`.

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

### 6. Property keys were treated as references — ✅ RESOLVED

Originally filed as "shorthand properties produce duplicate uses," which turned out to be one symptom of a broader bug: object literals had no branch in `walkVariables`, so the generic recursion walked `key` and `value` alike. But a **non-computed key is a label, not a reference** — only `{ [k]: v }` actually reads a variable.

```ts
const z = 1;              const o = { z };        // z: 2 uses — same offset, twice
const z = 1;              const o = { z: z };     // z: 2 uses — not shorthand at all
const a = 9; const b = 2; const o = { a: b };     // a: 1 use  — pure phantom
```

The third line was the real damage: `a` is a property name, but a variable named `a` in scope absorbed a use that doesn't exist in the source — a wrong edge, not just a duplicated one. Dedupe (as originally proposed here, mirroring `returns`, commit c39c185) would have fixed the first two and left the third.

Fix was a `Property` branch that walks the key only when `computed`, then always walks the value, then returns. The key/value asymmetry is the point: right of the colon is always a value expression, left of it is a name unless bracketed. Shorthand needs no special case — the parser fills both slots with the same identifier at the same offset, so skipping the label slot leaves exactly one use.

Same computed/non-computed split as gap 1's `MemberExpression` callee and `MethodDefinition`'s key. Three instances of one rule: **when `computed` is false the identifier is a name — read it, don't resolve it; when true it's a variable — resolve it, don't read it.**

### 7. Import resolution assumes `.ts`

The resolver appends `.ts` unconditionally, so pure-JS projects extract fine but never link. Directory imports (`./foo` → `./foo/index.ts`) and explicit extensions (`./foo.js` → `./foo.js.ts`) also fail. Fix: try a candidate list of extensions and index files.

---

## Next up

1. **Destructuring feed targets** (gap 4) — `const { a, b } = foo()` still only stamps `b`. Smallest remaining.
2. **Reassignment** (gap 5) — `x = foo()` sets no feed target at all.
3. **Cross-file test harness** — engine-level tests exist now (`src/tests/engine.test.ts`, 8 passing), but `flow.ts` does linking, graph assembly, and serving at module scope, so there's no function to call. Extract `analyze(dir) → Graph` before anything can test linking, or gap 7.
4. **Two-pass resolution** (gap 2) — invasive rewrite of the core walk. Everything above is cheaper; do this after.
5. **Types decision** (remainder of gap 3) — do type references belong in a data-flow graph at all?
6. **MCP wrapper** — serve the graph to agents once coverage is trustworthy.

Still worth measuring, on a real repo: what fraction of uses resolve, what fraction of call sites resolve, and how often two same-named methods collide within one file. The last decides whether gap 1's ignored receiver needs revisiting.

---

*Last updated: August 9, 2026*