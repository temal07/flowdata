import { test, expect } from 'bun:test';
import { parse } from "@typescript-eslint/typescript-estree"
import { collectVariables } from '../scripts/engine';

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

// Gap 5 — only declaration initializers set a flow target.
test.todo("reassignment produces an edge", () => {
    expect(edges(`function foo(){return 1} let x; x = foo();`)).toEqual(["foo -> x"]);
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

// Gap 7 (import resolution assumes `.ts`) is cross-file, so it can't be tested
// through collectVariables. It needs the `analyze(dir)` extraction out of
// flow.ts and a fixture directory.


 // ==== TODOs ====

// Gap 2 — uses before their declaration are dropped (no node, no edge, no warning).
test.todo("a call above a hoisted function still records a use", () => {
    expect(useCounts(`foo(); function foo(p) {}`).foo).toBe(1);
});

test.todo("a forward reference resolves to the later declaration", () => {
    expect(edges(`const a = b; const b = 2;`)).toEqual(["b -> a"]);
});

test.todo("a loop body sees the loop variable", () => {
    expect(edges(`for (let i = 0; i < 3; i++) { const b = i; }`)).toEqual(["i -> b"]);
});

// Gap 3 — bindings that bypass the scope stack can never be resolved against.
test.todo("a class is resolvable as a use", () => {
    expect(edges(`class R {} const r = R;`)).toEqual(["R -> r"]);
});

test.todo("a catch parameter is resolvable as a use", () => {
    expect(edges(`try {} catch (err) { const e = err; }`)).toEqual(["err -> e"]);
});