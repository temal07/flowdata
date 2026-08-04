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
