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
            if (use.feeds) output.push(`${decl.name} -> ${use.feeds.name}`)
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
test.todo("a method call traces its argument into the method's parameter", () => {
    expect(edges(`class R { score(p) { return p } } const r = new R(); const z = 1; const out = r.score(z);`))
        .toContain("z -> p");
});

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

// TS type declarations are the third member of this family, but they need a
// decision first: `TSTypeAnnotation` is skipped on purpose (engine.ts) to keep
// annotations out of the graph. Putting types on the scope stack alone won't
// make `const x: Result` resolve — that's a separate call about whether type
// references belong in a data-flow graph at all.

// Gap 4 — a destructuring pattern only stamps its last bound name.
test.todo("destructuring binds every name, not just the last", () => {
    expect(edges(`function foo(){return 1} const { a, b } = foo();`))
        .toEqual(["foo -> a", "foo -> b"]);
});

// Gap 5 — only declaration initializers set a flow target.
test.todo("reassignment produces an edge", () => {
    expect(edges(`function foo(){return 1} let x; x = foo();`)).toEqual(["foo -> x"]);
});

// Gap 6 — shorthand property key and value are the same identifier, walked twice.
test.todo("a shorthand property records one use, not two", () => {
    expect(edges(`const z = 1; const o = { z };`)).toEqual(["z -> o"]);
});

// Gap 7 (import resolution assumes `.ts`) is cross-file, so it can't be tested
// through collectVariables. It needs the `analyze(dir)` extraction out of
// flow.ts and a fixture directory.