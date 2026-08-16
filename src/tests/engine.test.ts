import { test, expect } from 'bun:test';
import { parse } from "@typescript-eslint/typescript-estree"
import { collectVariables } from '../scripts/engine';
import { isProjectSource, allowsJsx, analyse } from '../scripts/analyse';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';

// A function to flatten the messy output into the 
// thing you want to assert on

function edges(source: string): string[] {
    const ast = parse(source, { loc: true, range: true });
    const results = collectVariables(ast as any, "/test.ts");
    
    const output: string[] = [];
    for (const decl of results.declarations) {
        for (const use of decl.uses) {
            // one use can feed several declarations — flatten to one string each
            for (const fed of use.feeds ?? []) output.push(`${decl.name} -> ${fed.name}`)
        }
    }
    return output.sort();
}


test("a call result feeds the variable it's assigned to", () => {
    expect(edges(`function foo() { return 1; } const x = foo();`)).toEqual([
        "foo -> x",
    ]);
});

test("argument flows into the matching parameter", () => {
    expect(edges(`function foo(p){ return p } const z = 2; const a = foo(z);`))
      .toEqual(["foo -> a", "z -> p"]);
  });
  
test("inner scope shadows outer", () => {
    expect(edges(`const x = 1; function f(){ const x = 2; const y = x; }`))
        .toEqual(["x -> y"]);
});

test("nested calls chain through parameters", () => {
    expect(edges(`function id(p){return p} function wrap(q){return q} const z=1; const a = wrap(id(z));`))
        .toEqual(["id -> q", "wrap -> a", "z -> p"]);
});

// `edges` only sees uses that carry a feeds edge. Some gaps are about the use
// being dropped entirely, with no edge involved — count uses per name instead.
function useCounts(source: string): Record<string, number> {
    const ast = parse(source, { loc: true, range: true });
    const results = collectVariables(ast as any, "/test.ts");

    const counts: Record<string, number> = {};
    for (const decl of results.declarations) {
        counts[decl.name] = (counts[decl.name] ?? 0) + decl.uses.length;
    }
    return counts;
}

// ---------------------------------------------------------------------------
// Known gaps — see NOTES.md. Each is written as it should behave once fixed.
// Drop the `.todo` when you take one on; the test then tells you if you're done.
// ---------------------------------------------------------------------------

// Gap 1 — method calls don't reach parameters.
// Only the argument->parameter hop is asserted: what else the call site should
// emit (`score -> out`? `r -> out`?) is still an open design question, so this
// deliberately uses toContain rather than pinning the whole edge set.
test("a method call traces its argument into the method's parameter", () => {
    expect(edges(`class R { score(p) { return p } } const r = new R(); const z = 1; const out = r.score(z);`))
        .toContain("z -> p");
});

// Gap 3 — classes, methods, and catch params used to push straight into
// `results.declarations` instead of onto the scope stack, so they became nodes
// no use could ever resolve against. They now push onto the current scope like
// every other binding.
test("a class is resolvable as a use", () => {
    expect(edges(`class R {} const r = R;`)).toEqual(["R -> r"]);
});

test("a catch parameter is resolvable as a use", () => {
    expect(edges(`try {} catch (err) { const e = err; }`)).toEqual(["err -> e"]);
});

// TS type declarations are the third member of this family, but they need a
// decision first: `TSTypeAnnotation` is skipped on purpose (engine.ts) to keep
// annotations out of the graph. Putting types on the scope stack alone won't
// make `const x: Result` resolve — that's a separate call about whether type
// references belong in a data-flow graph at all.

// Gap 4 — the feed target used to be "the last declaration in scope", which
// was wrong two ways: a pattern binding several names only stamped one, and a
// multi-declarator statement stamped the *statement's* last name rather than
// the declarator's own. The second case produced an actively wrong edge, so
// it's tested here alongside the filed one.
test("destructuring binds every name, not just the last", () => {
    expect(edges(`function foo(){return 1} const { a, b } = foo();`))
        .toEqual(["foo -> a", "foo -> b"]);
});

test("each declarator feeds its own name, not the statement's last", () => {
    expect(edges(`function f(){return 1} function g(){return 2} const a = f(), b = 9, c = g();`))
        .toEqual(["f -> a", "g -> c"]);
});

test("a nested pattern binds its leaves, not the intermediate key", () => {
    expect(edges(`function foo(){return 1} const { a: { c }, b } = foo();`))
        .toEqual(["foo -> b", "foo -> c"]);
});

// Loop traversal order — not a hoisting gap, despite looking like one. The
// generic walk recurses over `Object.values(node)`, and typescript-estree
// emits properties alphabetically, so `body` came before `init`/`left`/`test`/
// `update` and the body was walked before the loop variable existed. The loop
// statements now name their children in source order (engine.ts). The `for...of`
// case is the guard on `left` being walked before `body`, and on `right` too.
test("a loop body sees the loop variable", () => {
    expect(edges(`for (let i = 0; i < 3; i++) { const b = i; }`)).toEqual(["i -> b"]);
});

test("a for...of body sees the loop variable", () => {
    expect(edges(`const xs = [1]; for (const x of xs) { const b = x; }`))
        .toEqual(["x -> b"]);
});

// Gap 2 — a use reached before its declaration used to resolve to nothing and
// be silently discarded. It is now held in `pendingUses` with a snapshot of the
// scopes visible from that spot, and the lookup is retried once the walk is
// over. Not a second walk: the snapshot's Scope objects are the live ones, so
// their declarations finish filling on their own.
test("a call above a hoisted function still records a use", () => {
    expect(useCounts(`foo(); function foo(p) {}`).foo).toBe(1);
});

test("a forward reference resolves to the later declaration", () => {
    expect(edges(`const a = b; const b = 2;`)).toEqual(["b -> a"]);
});

// The guard on the retry being *scoped* rather than a name match over the whole
// file: `y`'s block was popped before `z` was walked, so it was never on `z`'s
// snapshot and must stay unresolved. Fails if the retry ever searches the live
// stack, or all declarations, instead of `note.chain`.
test("a use does not resolve to a declaration from a closed block", () => {
    expect(edges(`{ const y = 1; } const z = y;`)).toEqual([]);
});

// The guard on one unresolvable name not taking the others down with it: `foo`
// never resolves, but it is only one entry in the retry loop. An early `break`
// there dropped every note behind it.
test("an unresolvable name does not block later deferred uses", () => {
    expect(edges(`foo(); const a = b; const b = 2;`)).toEqual(["b -> a"]);
});

// Gap 5 — only declaration initializers used to set a flow target, so a bare
// `x = foo()` produced nothing. Both identifiers always resolved; what was
// missing was the `feeds` stamp. The AssignmentExpression branch now points
// currentFeedTargets at the thing being written before walking the right side.
test("reassignment produces an edge", () => {
    expect(edges(`function foo(){return 1} let x; x = foo();`)).toEqual(["foo -> x"]);
});

test("a compound assignment feeds its target", () => {
    expect(edges(`function foo(){return 1} let x = 0; x += foo();`)).toEqual(["foo -> x"]);
});

// The guard on `left` being walked before the target is set. Walking it after
// would stamp the write as flowing into itself.
test("an assignment does not feed its target into itself", () => {
    expect(edges(`let x; x = 1;`)).toEqual([]);
});

// A member expression has no binding to point at, so no edge is invented —
// same rule as gap 1's unresolvable method calls.
test("assigning to a property invents no edge", () => {
    expect(edges(`function foo(){return 1} const o = {}; o.p = foo();`)).toEqual([]);
});

// The guard on save/restore. An early version wiped currentFeedTargets to []
// instead of restoring it, which silently dropped the enclosing target for
// everything walked after the assignment — `bar -> a` was the casualty.
// toContain, because the incidental `x -> a` and `foo -> x` are not the point.
test("an assignment restores the enclosing feed target", () => {
    expect(edges(`function foo(){return 1} function bar(){return 2} let x; const a = (x = foo()) + bar();`))
        .toContain("bar -> a");
});

// Chained assignment produces the hops rather than a direct `foo -> x`, which
// query.ts traverses transitively. Documented, not accidental.
test("a chained assignment links through each target", () => {
    expect(edges(`function foo(){return 1} let x; let y; x = y = foo();`))
        .toEqual(["foo -> y", "y -> x"]);
});

// When the left side can't be named, the enclosing target passes through
// rather than being cleared: not knowing where the write lands says nothing
// about where the expression's own value goes. Fails if that falls back to [].
test("an unnameable assignment target keeps the enclosing feed target", () => {
    expect(edges(`function foo(){return 1} const a = (undeclared = foo());`))
        .toContain("foo -> a");
});

// Gap 6 — a non-computed property key is a label, not a reference. Shorthand
// was the visible symptom (key and value are separate nodes at the same
// offset, so the walk recorded `z` twice), but `{ a: b }` was the worse case:
// it invented a use of `a` that isn't in the source. Only a computed key,
// `{ [k]: v }`, really reads a variable — that last test is the guard on the
// `node.computed` check, and it fails if the Property branch skips the key
// unconditionally.
test("a shorthand property records one use, not two", () => {
    expect(edges(`const z = 1; const o = { z };`)).toEqual(["z -> o"]);
});

test("a property key that shadows a variable records no use", () => {
    expect(edges(`const a = 9; const b = 2; const o = { a: b };`)).toEqual(["b -> o"]);
});

test("a computed property key still resolves as a use", () => {
    expect(edges(`const k = "x"; const v = 2; const o = { [k]: v };`))
        .toEqual(["k -> o", "v -> o"]);
});

// Gap 9 — the fourth place gap 6's rule holds, and the one it was never
// applied to: *reading* a member expression. `o.p` had no branch, so the
// generic recursion walked `property` and looked `p` up as a variable. When
// nothing was named `p` that was only noise; when something was, it invented
// an edge. Same fix shape as the Property branch above.
test("a member property that shadows a variable records no use", () => {
    expect(edges(`const p = 99; const o = { p: 1 }; const a = o.p;`)).toEqual(["o -> a"]);
});

test("a computed member property still resolves as a use", () => {
    expect(edges(`const k = "p"; const o = { p: 1 }; const a = o[k];`))
        .toEqual(["k -> a", "o -> a"]);
});

// The guard on the trap in that fix. A method call's edge comes from resolving
// the callee's *property* — `score` — which is exactly what the new branch
// skips. CallExpression therefore walks its own callee rather than delegating
// to the generic walk. Without this test the naive version of gap 9's fix
// silently deletes `score -> out` and the whole suite still passes; that was
// verified, not assumed.
test("a method call still records a use of the method name", () => {
    expect(edges(`class R { score(q) { return q } } const r = new R(); const z = 1; const out = r.score(z);`))
        .toContain("score -> out");
});

// Gap 12 — the same rule a fifth time. TSInterfaceDeclaration pushed its name
// and then fell through to the generic recursion, which walked the body and
// looked every member key up as a variable. Interfaces and type aliases are
// pure type space, so they now return outright; `useCounts` rather than
// `edges` because the damage is a phantom *use*, with or without an edge.
test("an interface member does not use a same-named variable", () => {
    expect(useCounts(`const name = "x"; interface R { name: string; line: number }`).name).toBe(0);
});

test("a type alias member does not use a same-named variable", () => {
    expect(useCounts(`const name = "x"; type T = { name: string }`).name).toBe(0);
});

// Enums are the exception, and the reason the branch had to split rather than
// blanket-return: a member's *name* is a label, but its *initializer* is a
// real value expression. Getting these two backwards — walking `member.id`
// instead of `member.initializer` — passes every other test in this file.
test("an enum member name does not use a same-named variable", () => {
    expect(useCounts(`const A = 9; enum E { A } const z = A;`).A).toBe(1);
});

test("an enum member initializer still resolves", () => {
    expect(useCounts(`const SIZE = 5; enum E { A = SIZE }`).SIZE).toBe(1);
});

// Gap 7 (import resolution assumes `.ts`) is cross-file, so it can't be tested
// through collectVariables. It needs the `analyze(dir)` extraction out of
// flow.ts and a fixture directory.


// Gap 11 — a use of `console` was counted as a resolution failure, which put a
// permanent floor under the rate and hid real regressions behind it. Names no
// project declares now land in their own `external` bucket, so `unresolved` is
// the only number that moves when coverage actually changes.
function lookups(source: string) {
    const ast = parse(source, { loc: true, range: true });
    return collectVariables(ast as any, "/test.ts").lookups;
}

test("a global is counted as external, not as a failed lookup", () => {
    const l = lookups(`const x = 1; console.log(x);`);
    expect(l.unresolved).toBe(0);
    expect(l.external).toBeGreaterThan(0);
});

test("a name the project should have declared still counts as unresolved", () => {
    const l = lookups(`const a = definitelyNotAGlobal;`);
    expect(l.unresolved).toBe(1);
    expect(l.external).toBe(0);
});

// A declaration in the source shadows the globals list — the set is only
// consulted after the scope chain has already come up empty, so it can never
// mask a real binding.
test("a declared name never falls through to the globals list", () => {
    const l = lookups(`function map(f){ return f } const a = map(1);`);
    expect(l.external).toBe(0);
});

// Gap 10 — IGNORED_DIRS covers the usual homes for vendored code, but a
// checked-in bundle can live anywhere: src/viewer/lib/cytoscape.min.js was
// 8,621 of this repo's 8,876 nodes and swamped every whole-project number.
test("a minified bundle is not project source", () => {
    expect(isProjectSource("src/viewer/lib/cytoscape.min.js")).toBe(false);
    expect(isProjectSource("dist/app.min.mjs")).toBe(false);
});

test("ordinary source under lib/ is still project source", () => {
    expect(isProjectSource("src/viewer/lib/helpers.js")).toBe(true);
    expect(isProjectSource("src/scripts/engine.ts")).toBe(true);
});

test("vendored directories and ambient declarations stay excluded", () => {
    expect(isProjectSource("node_modules/foo/index.js")).toBe(false);
    expect(isProjectSource("src/types/global.d.ts")).toBe(false);
});

// Gap 13 — the glob has always matched `.tsx`/`.jsx`, but `parse` was never
// told, so `<div>` was read as a less-than. `.ts` has to stay false: there
// `<T>expr` is a type assertion, which is the whole reason TypeScript splits
// the two extensions.
test("JSX is enabled for every extension except .ts", () => {
    expect(allowsJsx("a.tsx")).toBe(true);
    expect(allowsJsx("a.jsx")).toBe(true);
    expect(allowsJsx("a.js")).toBe(true);
    expect(allowsJsx("a.ts")).toBe(false);
});

// Gaps 13 and 14, end to end. These are the first tests that run `analyse`
// rather than `collectVariables`, because neither gap is reachable from a
// source string — one is about a file extension and the other about surviving
// a file. Fixtures are written to a temp dir rather than committed: a
// deliberately unparseable `.ts` in the repo would fail `tsc --noEmit`.
async function fixtureDir(files: Record<string, string>): Promise<string> {
    const dir = `${tmpdir()}/flowdata-test-${crypto.randomUUID()}`;
    for (const [name, body] of Object.entries(files)) {
        await Bun.write(`${dir}/${name}`, body);
    }
    return dir;
}

test("one unparseable file does not take the whole run with it", async () => {
    const dir = await fixtureDir({
        "good.ts": `function foo(){ return 1 } const x = foo();`,
        "broken.ts": `function ( { { const =`,
    });
    const { filesAnalysed, skipped, graph } = await analyse(dir);

    expect(filesAnalysed).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.file).toEndWith("broken.ts");
    expect(skipped[0]!.reason.length).toBeGreaterThan(0);
    // the good file still produced a graph — a degraded result, not no result
    expect(graph.nodes.map((n) => n.name)).toContain("foo");

    await rm(dir, { recursive: true, force: true });
});

test("a .tsx file is analysed rather than failing to parse", async () => {
    const dir = await fixtureDir({
        "view.tsx": `const cls = "box"; const el = <div className={cls}>hi</div>;`,
    });
    const { filesAnalysed, skipped, graph } = await analyse(dir);

    expect(skipped).toHaveLength(0);
    expect(filesAnalysed).toBe(1);
    expect(graph.nodes.map((n) => n.name)).toContain("cls");

    await rm(dir, { recursive: true, force: true });
});

 // ==== Untested gaps ====

// No `.todo` left: every gap that collectVariables can express now has a test.
// The two that remain open aren't testable from here.
//
// Gap 7 (imports assume `.ts`) is cross-file — see the note above.
//
// Gap 8 (a use resolves to an outer declaration that a later inner one
// shadows) is testable in principle, but a test written now would pin the
// *wrong* answer. `useCounts` counts by name, and both declarations are called
// `x`, so distinguishing them needs an assertion on `start` offsets. Write it
// with the fix, not before.
