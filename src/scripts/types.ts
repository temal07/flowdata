/**
 * types.ts — the data model shared by every script in this folder.
 *
 * `engine.ts` produces these shapes while walking a single file's AST;
 * `flow.ts` (and `debug.ts`) consume them across every file in a project
 * to build the final dependency graph.
 */

/**
 * The category of a `Binding`. Roughly "what kind of thing was declared":
 *
 * - `"function"`  — function declarations, function expressions, arrow
 *                   functions (including `const foo = () => {}`, which is
 *                   classified as a function, not a variable).
 * - `"param"`     — a function parameter (or a leaf name inside a
 *                   destructured/defaulted/rest parameter).
 * - `"class"`     — a `class` declaration's name.
 * - `"variable"`  — a `var`/`let`/`const` binding whose initializer is not
 *                   a function.
 * - `"type"`      — a TS `type`, `interface`, or `enum` declaration.
 * - `"conditional"` — reserved; not currently produced anywhere in engine.ts.
 * - `"catch"`     — a `catch (err)` parameter.
 * - `"import"`    — a local name bound by an `import` specifier. flow.ts
 *                   later resolves these to the real declaration in the
 *                   imported file and merges the uses onto it, so "import"
 *                   bindings never make it into the final graph themselves.
 */
export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "conditional" |
    "catch" |
    "import"
;

/**
 * A single declaration site — a name introduced into scope somewhere in
 * the source — together with every reference (`uses`) to it that the walk
 * found.
 *
 * `file` + `start` together are a stable, unique identity for a
 * declaration (see `nodeId` in flow.ts), since a byte offset is unique
 * within a file.
 */
export interface Binding {
    /** For `kind: "import"` only: the module specifier the import came from
     *  (e.g. `"./engine"` or `"acorn"`), rewritten to an absolute path for
     *  relative imports so it can be looked up in the project's per-file
     *  results — see the ImportDeclaration handling in engine.ts. */
    source?: string;
    /** The identifier's text, e.g. `"foo"`. */
    name: string;
    /** 1-based source line of the declaration (from `loc`, not `range`). */
    line: number;
    /** The `var` / `let` / `const` keyword for variable declarations;
     *  `""` or `"N/A"` for kinds where a declaration keyword doesn't apply
     *  (params, functions, classes, types, catch params). */
    varType: string;
    /** Absolute path of the file this declaration lives in. */
    file: string;
    kind: Kind;
    /** For `kind: "function"` only: this function's declared parameters,
     *  in positional order, so call arguments can be matched to them by
     *  index (see the CallExpression handling in engine.ts). Populated for
     *  both named functions and anonymous functions assigned to a variable
     *  (`const foo = () => {}`). */
    params?: Binding[];
    /** Reserved for interprocedural flow (tracing a function's `return`
     *  value back to its call sites) — not yet populated by engine.ts. */
    returns?: {name: string, file: string, start: number}[];
    /** 0-based byte offset of the declaration's identifier (from `range`).
     *  Combined with `file`, this is the declaration's stable node id. */
    start: number;
    /** Always `"declaration"` for entries in `Results.declarations` —
     *  distinguishes a `Binding` from the `Use` entries nested under it. */
    role: "declaration" | "use";
    /** Every reference to this binding found during the walk. */
    uses: Use[];
}

/**
 * A single reference to a `Binding` — an `Identifier` node whose name
 * resolved to a declaration already on the scope stack.
 */
export interface Use {
    name: string;
    file: string;
    line: number;
    /** 0-based byte offset of this reference (its own position, not the
     *  declaration's). */
    start: number;
    /** Set when this use occurs somewhere a value flows onward from —  a
     *  variable initializer or a call argument. Points at the `{file,
     *  start}` identity of the declaration the value flows *into* (the
     *  declared variable, or the matching function parameter). Absent when
     *  the use isn't inside a flow-carrying position. See the "feeds
     *  mechanism" doc comment at the top of engine.ts. */
    feeds?: { name: string; file: string; line: number; start: number; };
}

/**
 * One level of lexical scope while walking (global, a function body, or a
 * `{ }` block). `engine.ts` keeps a stack of these so an `Identifier` can
 * be resolved against the innermost scope outward, and so declarations
 * introduced in a scope can be flushed into the file's `Results` once that
 * scope is fully walked (see the pop-phase handling of FunctionDeclaration
 * / FunctionExpression / ArrowFunctionExpression / BlockStatement in
 * engine.ts).
 */
export type Scope = {
    name: string;
    declarations: Binding[];
    /** The `currentFeedTarget` that was active just before entering this
     *  scope, restored when the scope is popped so flow tracking doesn't
     *  leak into or out of the scope it doesn't belong to. */
    savedFeedTarget: Binding | null;
    /** The `currentFunction` that was active just before entering this
     *  scope, restored when the scope is popped so flow tracking doesn't
     *  leak into or out of the scope it doesn't belong to. */
    /* 
        Only works for function scopes
    */
    savedFunction: Binding | null;
}

/** The output of walking one file: every declaration found in it, each
 *  with its uses already attached. Produced by `collectVariables`. */
export interface Results {
    declarations: Binding[];
}
