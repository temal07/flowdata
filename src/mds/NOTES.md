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
| Forward references                           | ✅ Done — deferred lookup, see gap 2  |
| Reassignment (`x = foo()`)                   | ✅ Done — not destructuring, see gap 5|
| MCP wrapper                                  | ⏳ Planned                            |


---

## What works

Most of these are guarded by `bun test` (`src/tests/engine.test.ts`); the rest were checked by reading `collectVariables` output.

**Scope and shadowing.** `const x = 1; function f() { const x = 2; const y = x }` — the inner `x` feeds `y`; the outer `x` is untouched.

**Feed targets nest correctly.** Save/restore around each declarator means `const a = () => { const b = x }` gives `x` feeds `b`, not `a`. Multiple uses in one init (`const c = x + y`) resolve to the right target.

**Every declarator feeds its own names.** `const a = f(), b = 9, c = g()` gives `f` feeds `a` and `g` feeds `c`; `const { a, b } = foo()` feeds both. (The earlier claim here that multiple declarators already worked was wrong — see gap 4.)

**Full interprocedural chain.** `function foo(p) { return p } const z = 2; const a = foo(z)` produces `z` feeds `p`, `foo.returns = [p]`, and `foo` feeds `a`. `query.ts` stitches these into one path — this is the v1.2 goal, and it is done. (The old note saying flow is "intraprocedural only" was stale.)

**Nested calls chain.** `const a = wrap(id(z))` gives `z` feeds `p` (id's param), `id` feeds `q` (wrap's param), `wrap` feeds `a`. The argument walk recurses properly.

**Method calls reach parameters.** `class R { score(p) { return p } } const r = new R(); const out = r.score(z)` gives `z` feeds `p`. Works for `this.m(x)` and private `this.#m(x)` too. See the caveats in gap 1 below.

**Classes and catch params resolve.** `class R {} const r = R` gives `R` feeds `r`; `try {} catch (err) { const e = err }` gives `err` feeds `e`.

**Property keys aren't mistaken for references.** `const o = { a: b }` records a use of `b` only; the key `a` is a label, even when a variable named `a` is in scope. `{ z }` records one use, not two. Computed keys still resolve: `{ [k]: v }` records both `k` and `v`.

**Forward references resolve.** `const a = b; const b = 2` gives `b` feeds `a`, and `foo(); function foo(p) {}` records the call as a use of `foo`. A use that can't resolve when the walk reaches it is retried after the walk instead of being dropped — see gap 2. Still correctly scoped: `{ const y = 1; } const z = y` produces nothing, because the block had closed.

**Loop bodies see the loop variable.** `for (let i = 0; i < 3; i++) { const b = i }` gives `i` feeds `b`. This looked like a hoisting problem and wasn't — see the first bullet under gap 2.

**Reassignment produces edges.** `let x; x = foo()` gives `foo` feeds `x`, and so does `x += foo()`. Assignments nested in an expression restore the enclosing target rather than clearing it, so `const a = (x = foo()) + bar()` still gets `bar` feeds `a`. Destructuring assignment is the exception — see gap 5.

---

## Known gaps

Ordered by how much they cost on real code. Each has a snippet that reproduces it. **Numbering is stable** — resolved entries stay in place rather than being renumbered, because `src/tests/engine.test.ts` refers to them by number.

### 1. Method calls don't reach parameters — ✅ RESOLVED

The call-site branch used to be gated on `node.callee.type === "Identifier"`, so `obj.m(x)` was skipped entirely. It now also accepts a non-computed `MemberExpression` callee and reads the name from `callee.property.name`. Methods additionally get their `params` and `returns` populated: `MethodDefinition` points `currentFeedTarget` at the method's binding before walking its (always anonymous) `FunctionExpression`, which is how `const f = () => {}` has always worked.

Three things this deliberately does **not** do:

- **The receiver is ignored.** Resolution is by method name only — `b.score(z)` never checks what `b` is. With two same-named methods in scope, `.find()` takes the first, which can be the wrong class. Decided (August 9, 2026) to keep it: the alternative is real type inference, and without name-only matching there are no method edges at all. Revisit if measurement says the collision rate is high.
- **Computed forms are skipped.** `r[k](z)` and `class R { [name]() {} }` have no statically-known name — the identifier there names a *variable holding* the name, so reading it would silently produce a wrong answer. Both bail out on `computed === true`.
- **Unresolvable member calls now emit no argument edge.** Previously `a.b.c(z)` fell through and `z` picked up the ambient feed target, giving a coarse `z → out`. Now the branch fires, finds nothing, and sets the target to null. This matches how unresolved *plain* calls have always behaved, but it does drop argument edges for object-literal methods and built-ins (`arr.map(fn)`, `str.split(sep)`).

### 2. Uses before their declaration are dropped — ✅ RESOLVED, except under shadowing

A single walk in source order meant a declaration had to be visited before any use of it. When it wasn't, the identifier resolved to nothing and **the use was silently discarded** — no node, no edge, no warning.

```ts
foo(); function foo(p) {}       // `foo` ended up with zero uses
const a = b; const b = 2;       // `b` ended up with zero uses
```

The fix filed here was two-pass resolution — pass 1 collects declarations, pass 2 resolves uses against complete scopes. **That was abandoned.** Its hard part (rebuilding the scope stack on the second walk and giving scopes stable identity across both) turned out to be avoidable entirely.

What shipped instead is a **deferred lookup**. When an identifier doesn't resolve, `walkVariables` files a `PendingUse` — the `Use` itself, a snapshot of the scope chain, and the `inReturnStatement` / `currentFunction` values live at that moment — and keeps walking. `collectVariables` retries every pending lookup once the walk is over, by which point every declaration exists. No second walk, no pre-pass.

The snapshot is the whole trick, and it is deliberately **shallow**. `[...stack]` copies the array, so later pushes and pops can't disturb it — the record of *which* scopes were visible is frozen. But the `Scope` objects inside are the live ones, so their `declarations` keep filling as the walk continues and are complete by retry time. **Freeze which scopes; don't freeze what's in them.**

Correct scoping falls out of that for free, in both directions:

```ts
const a = b; const b = 2;       // resolves — both share the one live global Scope
{ const y = 1; } const z = y;   // does NOT resolve — the block had already popped
                                // when `z` was walked, so it was never on the chain
```

`lookup` and `attachUse` were extracted from the identifier branch so the deferred path behaves identically to the immediate one — in particular a forward reference inside a `return` still stamps `returns` on the enclosing function, which is why the note carries `inReturnStatement`/`fn` rather than reading the module variables (both are back to `false`/`null` by retry time).

Four things worth knowing:

- **The third example originally filed here was misfiled.** `for (let i = 0; i < 3; i++) { const b = i }` was never a hoisting problem. The generic recursion iterates `Object.values(node)` and typescript-estree emits properties alphabetically, so `body` came before `init`/`left`/`test`/`update` and the walker reached the body before the loop variable. Nothing there is used before it is *declared*, only before the walker happened to *arrive*. Fixed separately, by naming loop children in source order the way `VariableDeclaration` and `MethodDefinition` already do.
- **Shadowing is still wrong** — see gap 8, which is where the measurement and the fix live. The short version: the retry fires on lookup *failure*, and shadowing is a lookup *success with the wrong answer*, so no note is ever written.
- **TDZ is ignored on purpose.** `const a = b; const b = 2` is a `ReferenceError` at runtime. The edge is drawn anyway — this is a graph of where values *would* flow, not a soundness checker.
- **One dead name must not take the others down with it.** The retry loop's failure branch has to `continue`, not `break`; an early `break` dropped every note queued behind the first unresolvable one. Guarded by a test.

To check any of this: `bun run src/scripts/trace.ts <file>`. The closing line reports how many uses stayed unresolved after the retry.

### 3. Classes, methods, types, and catch params are never resolvable — ✅ RESOLVED for classes/methods/catch

These four used to push straight into `results.declarations` instead of onto the scope stack. They became nodes in the graph, but the identifier lookup only searches the scope stack, so no use ever resolved to them. All four now push onto the current scope like every other binding, and classes, methods, and catch params resolve.

One wrinkle worth knowing: there is no scope for a class body (`ClassBody` isn't a `BlockStatement`), so a method name lands in the scope *enclosing* the class. That isn't lexically correct — `score` is a property of `R`, not a name in the surrounding scope — but it's what makes `r.score(z)` resolve at all, and it's the same imprecision as gap 1's ignored receiver.

**Types are still open.** The walk returns early on `TSTypeAnnotation` by design, to keep annotations out of the graph, so the scope-stack change alone doesn't make `const x: Result` resolve. That needs a separate decision about whether type references belong in a data-flow graph at all.

```ts
type Result = {...}; const x: Result   // Result: still 0 uses
```

Related, fixed alongside: `makeBinding` used to read `idNode.name` unconditionally, producing a nameless binding for literal keys like `class R { "my-method"() {} }`. It now falls back to `String(idNode.value)`, matching `makeUse`.

### 4. Declarators fed the wrong target — ✅ RESOLVED

Filed as "destructuring only binds the last name," but the root cause was broader. `VariableDeclaration` pushed **every** declarator's names up front, then each `VariableDeclarator` took "the last declaration in the current scope" as its feed target. So a declarator had no idea which bindings were its own:

```ts
const { a, b } = foo();               // foo fed `b` only — `a` got nothing
const a = foo(), b = 2;               // foo fed `b` — a variable it never touches
const a = f(), b = 9, c = g();        // f and g both fed `c`
```

The second and third lines are the worse half: not a missing edge but a **wrong** one, pointing at a variable the value never reaches. This also falsified the "What works" claim about multiple declarators, which only looked right because the example happened to put the call in the last declarator.

Fix had two parts:

- **Pairing.** The `VariableDeclarator` branch is gone; declarators are now walked inside the `VariableDeclaration` branch, which slices the scope's declarations around each `collectPatternNames` call. That slice *is* the set of names the declarator introduced — one normally, several for a pattern, none for a bare `let x`. A declarator can't do this itself: it can't see `node.kind` for the var/let/const keyword either.
- **Multiple targets.** `currentFeedTarget: Binding | null` became `currentFeedTargets: Binding[]` (empty = not in a flow-carrying position), and `Use.feeds` became a list. One use genuinely can feed several declarations — `const { a, b } = foo()` reads `foo` once. Recording it as one use with two targets keeps `uses` an honest count of source occurrences; the alternative, a duplicated use per target, is the bug gap 6 removed. `flow.ts` loops over the list and emits one edge per entry.

Nested patterns and rest elements fall out for free, since `collectPatternNames` already walked them: `const { a: { c }, b } = foo()` feeds `c` and `b` (not the intermediate key `a`), and `const [a, ...rest] = foo()` feeds both.

**Behavior change worth knowing:** names are now pushed per declarator instead of all up front, so a forward reference *within one statement* — `const a = () => b, b = 2` — no longer resolves. That reading was accidental (it relied on `b` being pushed before `a`'s initializer was walked), and matches gap 2, which is where forward references belong.

### 5. Reassignment isn't tracked — ✅ RESOLVED

Only `const`/`let`/`var` initializers set a feed target, so a bare `AssignmentExpression` set nothing and `let x; x = foo()` produced no edge at all.

Worth being precise about what was broken, because the filing here was misleading: **both identifiers already resolved.** `x` found its declaration and `foo` found its function; each got a `Use` recorded. The only thing missing was the `feeds` stamp, because nothing outside a declarator's initializer ever pointed `currentFeedTargets` anywhere. So the fix belonged in the walk's feed-target bookkeeping, nowhere near `lookup`.

The new `AssignmentExpression` branch does for `x = foo()` what `VariableDeclaration` does for `const x = foo()` — save, point `currentFeedTargets` at the thing being written, walk the right-hand side, restore. Three decisions inside it, each with a test:

- **`left` is walked before the target is set.** After would stamp the write as flowing into itself, so `x = 1` would emit `x -> x`.
- **When `left` can't be named, the enclosing target passes through rather than being cleared.** `o.p = foo()` and `undeclared = foo()` are the same situation: we can't say where the *write* lands, but that says nothing about where the expression's own value goes, and `const a = (o.p = foo())` really does put foo's result in `a`. Clearing to `[]` would assert "flows nowhere", which is a stronger claim than the truth.
- **Compound operators need no special case.** `x += foo()` still lands foo's value in `x`, so the target is identical, and `x` genuinely *is* read there, which walking `left` normally already records.

Two things it does by hops rather than directly, both intentional and both tested. Chained assignment `x = y = foo()` gives `foo -> y` and `y -> x` rather than a direct `foo -> x`; and a nested assignment `const a = (x = foo())` gives `foo -> x` and `x -> a`. `query.ts` traverses transitively, so the paths are intact either way, and the hop form is arguably more honest about what the source says.

**Not fixed: destructuring assignment.** `[a, b] = foo()` and `({ a } = foo())` have `ArrayPattern`/`ObjectPattern` on the left, and the branch only names an `Identifier`, so they fall through to the pass-through case and emit no edge. `collectPatternNames` is the wrong tool — it *declares* names, and these already exist — so this needs a sibling that collects leaf identifiers and looks each one up. Rare enough in real code to leave.

The wider imprecision underneath all of this is that variables aren't versioned. `let x = expensive(); x = foo(); const a = x` records both `expensive -> x` and `foo -> x`, so a forward trace from `expensive` reaches `a` even though that value was overwritten. Fixing it means SSA-style renaming, which is a much larger change than gap 5 was.

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

### 8. A use resolves to an outer declaration that a later inner one shadows

The residue of gap 2. A use is resolved against the scopes as they stand *at that moment*, so a declaration that appears later in an inner scope never gets the chance to shadow.

```ts
const x = 1; function f() { const y = x; const x = 2 }
//                                    ↑ resolves to x@6 (outer); should be x@47

function foo() { return 1 }
function f() { const a = foo(); function foo() { return 2 } }
//                        ↑ resolves to foo@9 (outer); should be foo@69
```

The second is the one that matters. The `const` version is a TDZ `ReferenceError` — already-broken code — but an inner `function` declaration really is hoisted and really does shadow, so that call returns 2 and the graph says otherwise.

Gap 2's retry cannot reach this: it fires on lookup *failure*, and this is a lookup *success with the wrong answer*. Nothing distinguishes it from a correct resolution at the moment it happens, so no `PendingUse` is ever filed.

**Measured, August 15 2026.** Deferring *every* identifier rather than only the failures — a one-line change, `walkVariables` never resolving inline — fixes both cases: the retry's `chain` holds the lexically enclosing scopes, and by retry time each holds all of its declarations, so `lookup` finds the genuinely innermost one. All 19 engine tests still pass, and it is not slower (0.70 vs 0.73 ms per walk over a 600-line file — the eager lookup is traded for a deferred one, not added to).

**What blocks it is not cost, it's the call-site lookup.** `CallExpression` does its own separate resolution to reach `calledFunc.params`, and that one genuinely *can't* be deferred — it needs the callee's parameters *during* the walk, to set the feed target before the arguments are walked. Deferring only the identifiers splits the graph's story in two:

```ts
function foo(p) { return 1 }
function f(z) { const a = foo(z); function foo(q) { return 2 } }
// use of `foo` → inner foo@72   (fixed)
// z -> p       → OUTER foo's param@13   (not fixed; should be q@76)
```

The graph would then assert both "this call is the inner `foo`" and "its argument flows into the outer `foo`'s parameter," and `query.ts` — which traverses `feeds` — would walk into a body the graph says was never called. Being *consistently* wrong is more tractable than being *inconsistently* wrong, and it matches how gap 1's ignored receiver already behaves.

So: do the two together, as one change, or not at all. Worth measuring the frequency of inner-hoisted-function shadowing on a real repo first — if it's rare, this stays cheap to ignore.

---

## Next up

1. **Cross-file test harness** — now the smallest real gap. The blocker named here is gone: `analyse(dir) → Graph` exists in `analyse.ts`, so there is a function to call. The fixture directory and the tests themselves still aren't written, and every engine test to date runs through `collectVariables` on a single string — nothing exercises linking. This is what unblocks gap 7.
2. **Types decision** (remainder of gap 3) — do type references belong in a data-flow graph at all?
3. **Shadowing + call-site resolution together** (gap 8, and the receiver half of gap 1) — the identifier half is a one-line change that already measures clean; it's the `CallExpression` lookup that has to move with it. Measure the frequency first.
4. **Destructuring assignment** (remainder of gap 5) — `[a, b] = foo()` needs a lookup-per-leaf sibling to `collectPatternNames`. Small, but rare enough in real code that it can wait for evidence.
5. **MCP wrapper** — serve the graph to agents once coverage is trustworthy.

Still worth measuring, on a real repo: what fraction of uses resolve, what fraction of call sites resolve, and how often two same-named methods collide within one file. The last decides whether gap 1's ignored receiver needs revisiting. The first is nearly free now — `collectVariables` already counts the uses that survive the retry unresolved; making that a `PendingUse[]` instead of a number would name them too.

---

*Last updated: August 15, 2026*