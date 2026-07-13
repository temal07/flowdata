# flowdata — dev notes

Static analysis engine for TypeScript/JavaScript. Parses source into an AST, resolves scope, extracts declarations and uses, links them across files, and traces data flow.

---

## Status

| Feature | State |
| --- | --- |
| Per-file extraction (declarations + uses) | ✅ Done |
| Scope resolution (functions, arrows, blocks) | ✅ Done |
| Cross-file linking (imports → declarations) | ✅ Done |
| Multi-hop `feeds` edges (v1) | ✅ Done — intraprocedural |
| Graph output + local viewer (`flow <dir>`) | ✅ Done |
| Interprocedural multi-hop (v1.2) | ⏳ Next |
| MCP wrapper | ⏳ Planned |

---

## v1.1 — Multi-hop (done)

Uses now record the declaration they flow into, via a `feeds` edge pointing at the fed declaration's `{ file, start }` identity.

```ts
const x = 5;
const a = foo();   // use of `foo` records feeds → a
```

**Verified working on:**
- Simple assignment — `const a = foo()` → `foo` feeds `a`
- Nesting — `const a = () => { const b = x }` → `x` feeds `b`, not `a` (save/restore of feed target)
- Multiple declarators — `const a = 1, b = foo()` → `foo` feeds `b`
- Multiple uses in one init — `const c = x + y` → both `x` and `y` feed `c`

### Known limitations (v1.1)

- **Intraprocedural only.** Flow stops at assignment sites. Does not yet trace *through* function returns or *into* parameters — e.g. `bar(z)` and `return w` aren't followed. → **v1.2.**
- **Destructuring targets.** For `const { a, b } = foo()`, the "last binding in scope" heuristic only grabs `b`, so `foo` feeds `b` but not `a`.
- **Assignment-based only.** Only stamps uses inside `const`/`let`/`var` initializers. Does not handle reassignment (`x = foo()`, an `AssignmentExpression`) or `return` / call-argument flow.

---

## Next up

1. **Interprocedural multi-hop (v1.2)** — trace flow through function returns and into parameters. The real def-use-chain-across-functions work.
2. **MCP wrapper** — serve the scope-correct graph to agents now that the payload is trustworthy.

---

## Deferred / known issues

### Use-before-declaration doesn't resolve
Single-pass walk assumes every declaration is visited before its uses. Breaks when a use precedes its declaration in walk order:

- `for` loop body walked before the `let i` init
- function hoisting — `foo(); function foo() {}`

**Fix:** two-pass resolution (pass 1 collect declarations, pass 2 resolve uses). Deferred — the hard part is carrying each scope's declarations from pass 1 into pass 2.

### JS-only cross-file linking gap
Import resolver hardcodes `.ts` when resolving local imports, so cross-file linking may silently fail on pure-JS projects (extraction works, edges don't). Fix: try multiple extensions when resolving.

---

*Last updated: July 13, 2026*