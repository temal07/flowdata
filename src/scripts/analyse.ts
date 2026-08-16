import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Graph, GraphEdge, Results } from "./types";
import { isAbsolute, resolve } from "path";

/**
 * Directories that are never the user's own source. Without this a plain
 * `flow .` walks node_modules and parses every dependency — in this repo
 * that's 496 of 505 matched files, and the resulting graph runs to gigabytes.
 */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor",
  "*.min.js",
]);

/** Extensions the glob matches, in the order a resolver should prefer them */
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];


/**
 * Determines if a given path (relative to `projectDir`) is a project source file
 * worth analyzing, by filtering out ignored directories and ambient type declaration files.
 *
 * @param {string} relativePath - The path relative to the project directory.
 * @returns {boolean} True if the file should be analyzed as project source, false otherwise.
 */
export function isProjectSource(relativePath: string): boolean {
  if (relativePath.split("/").some((segment) => IGNORED_DIRS.has(segment))) return false;
  /**
   * Ambient type declarations: no runtime values, so no data flow to trace,
   * and they're the bulk of what ships inside packages.
   */
  if (relativePath.endsWith(".d.ts")) return false;
  /**
   * Minified bundles. IGNORED_DIRS catches the usual homes for vendored code,
   * but a checked-in bundle can live anywhere — `src/viewer/lib/cytoscape.min.js`
   * is under none of them, and on its own accounted for 8,621 of this repo's
   * 8,876 nodes. 97% of the graph was a dependency nobody wants to trace, and
   * it swamped every whole-project measurement.
   *
   * Filtering on the directory name wouldn't generalise — `lib/` is ordinary
   * source in plenty of projects. The property that actually matters is that
   * the file is minified: the names are mangled, so every edge is noise. The
   * `.min.` marker is the cheap version of that test; the general one is a
   * maximum line length, which needs the file's contents rather than its path.
   */
  if (/\.min\.[cm]?js$/.test(relativePath)) return false;
  return true;
}

/**
 * Which analysed file an import specifier names. 
 * @param base: the absolute path (extensionless (e.g. .ts, .js)) path the engine produced
 * @param files: A set of files that will be checked
 * @returns the matching key of `files` or undefined if the import points outside
 * the analysed set.
 */
export function resolveImport(base: string, files: Set<string>) : string | undefined {
    // 1. First case: If the base file exists (e.g. /project/util)
    // return it.
    if (files.has(base)) return base;
    
    // 2. Second case: If the base file with the extension exists (e.g. /project/util.ts)
    // return it.
    for (const extension of IMPORT_EXTENSIONS) {
      const candidate = base + extension;
      if (files.has(candidate)) return candidate;
    }

    // 3. Third case: Directory imports. The default file that's imported
    // whenever a directory instead of a file is imported is "index.ts" (Node convention).
    for (const extension of IMPORT_EXTENSIONS) {
      const candidate = base + "/index" + extension;
      if (files.has(candidate)) return candidate;
    }

    // 4. Fourth case: JS paths instead of TS paths. (Same for JSX --> TSX)
    if (base.endsWith(".js")) {
      const sibling = base.slice(0, -3) + ".ts";
      if (files.has(sibling)) return sibling;
    }

    if (base.endsWith(".jsx")) {
      const sibling = base.slice(0, -4) + ".tsx";
      if (files.has(sibling)) return sibling
    }

    return undefined;
}

/**
 * Whether to parse this file as JSX.
 *
 * The glob has always matched `.tsx` and `.jsx`, but the parser was never told
 * about them, so every JSX file in a project failed — `<div>` was read as a
 * less-than and the errors landed several tokens later ("Unterminated regular
 * expression literal"), pointing nowhere near the cause. On Hono that was 21
 * files, and every parse failure in the repo was one of them.
 *
 * `.ts` is the one extension that must stay false: there `<T>expr` is a type
 * assertion, and turning JSX on would reinterpret it as an unclosed element.
 * That ambiguity is exactly why TypeScript splits `.ts` from `.tsx` in the
 * first place. Everything else the glob matches can carry JSX — `.js` files
 * routinely do — and none of them have the type-assertion syntax to lose.
 */
export function allowsJsx(path: string): boolean {
    return !path.endsWith(".ts");
}

/**
 * Longest snippet stored per edge occurrence. A minified file is a handful
 * of lines hundreds of kilobytes wide (cytoscape.min.js: 33 lines, longest
 * 229k chars); storing one verbatim per edge is what turned a 9-file graph
 * into 1.1GB of JSON. The viewer only renders a single line anyway.
 */
const MAX_SNIPPET = 200;

/**
 * A declaration's file+start is unique, so it doubles as a stable node id
 * for edges (feeds targets are stamped with the same file+start).
 * 
 * @param {string} file: the file it takes in
 * @param {number} start: start number (unique for each node)
 * @returns {string} a string combining the file and start position (number)
 */
function nodeId(file: string, start: number): string {
  return `${file}:${start}`;
}

/**
 * Analyzes all source files in the given project directory, building a comprehensive
 * data flow graph of declarations, uses, and flow connections (feeds/returns/edges).
 *
 * @param {string} projectDir - The path to the root directory to be analyzed.
 * @returns {Promise<{
 *   graph: Graph,                                 // The constructed data flow graph.
 *   filesAnalysed: number,                        // Number of files successfully analyzed.
 *   lookups: {                                    // Stats on identifier lookups.
 *     resolved: number,                           // Identifiers resolved to a declaration.
 *     unresolved: number,                         // Identifiers not resolved.
 *     external: number                            // Identifiers resolved as external (globals).
 *   },
 *   skipped: { file: string, reason: string }[]   // Files that could not be parsed and why.
 * }>}
 */
export async function analyse(projectDir: string): Promise<{
  graph: Graph,
  filesAnalysed: number,
  /** Every identifier lookup across every file, bucketed. `unresolved` is the
   *  one to watch: `external` is names no project declares (see KNOWN_GLOBALS
   *  in engine.ts), so only this number moving means coverage changed. */
  lookups: { resolved: number, unresolved: number, external: number },
  /** Files matched by the glob that could not be parsed, with the parser's
   *  first line of complaint. Empty on a clean run. Each entry is a file
   *  missing from the graph, so a consumer that cares about completeness has
   *  to look here — nothing else signals the loss. */
  skipped: { file: string, reason: string }[],
  unlinkedImports: number,
}> {
  // keep each file's source around so edge clicks can show the actual code
  // at the use site, not just a file:line reference.
  const fileTexts: Record<string, string> = {};

  /** Lines per file, split once — `codeAt` is called for every occurrence of
   *  every edge, and re-splitting a large source each time is not free. */
  const fileLines: Record<string, string[]> = {};

  /** The source line (trimmed, truncated) at `file:line`, for edge-click display. */
  function codeAt(file: string, line: number): string {
    const lines = (fileLines[file] ??= fileTexts[file]?.split("\n") ?? []);
    const text = lines[line - 1]?.trim() ?? "";
    return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
  }

  const glob = new Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");

  // Step 1: parse + walk every file in the project.
  const treeResults: Record<string, Results> = {};
  const skipped: { file: string, reason: string }[] = [];

  for await (const file of glob.scan(projectDir)) {
    // disregards non-project source files
    // specified in the isProjectSource function
    if (!isProjectSource(file)) continue;
    // resolves the absolute path of the file
    const absolutePath = resolve(projectDir, file);
    // reads the file's text content
    const code = await Bun.file(absolutePath).text();

    // Parse, and survive files that don't. A project you didn't write will
    // contain something this parser can't handle — a syntax level newer than
    // the installed version, a file the glob shouldn't have matched, a
    // half-finished edit. Letting that throw meant one bad file produced no
    // graph at all rather than a graph missing one file, which is the
    // difference between a degraded result and no result. Skips are collected
    // and returned rather than swallowed: an unanalysed file is a hole in the
    // graph, and a hole nobody is told about is worse than one they are.
    let tree;
    try {
      tree = parse(code, { loc: true, range: true, jsx: allowsJsx(absolutePath) });
    } catch (error) {
      skipped.push({ file: absolutePath, reason: String((error as Error).message).split("\n")[0]! });
      continue;
    }

    // collects the variables in the AST
    // and stores the results in the treeResults object
    // format: {"some path": Results}
    treeResults[absolutePath] = collectVariables(tree, absolutePath);
    // stores the file's text content
    fileTexts[absolutePath] = code;
  }

  // Step 2: for each file, for each import declaration, find the real
  // declaration in the source file and move the uses onto it.
  const analysedFiles = new Set(Object.keys(treeResults));

  // counts specifiers
  let unlinkedImports = 0;

  for (const fileResults of Object.values(treeResults)) {
    for (const binding of fileResults.declarations) {
      // disregard non-import bindings
      if (binding.kind !== "import") continue;

      // assign the source of the import
      const resolvedSource = resolveImport(binding.source!, analysedFiles);

      // if resolvedSource is undefined, increment the counter because
      // the import couldn't link
      if (!resolvedSource && isAbsolute(binding.source!)) unlinkedImports++;

      const sourceResults = resolvedSource ? treeResults[resolvedSource] : undefined;
 
      // for undefined values of sourceResults, which are due to
      // packages and dependencies being imported, simply skip them
      if (sourceResults === undefined) continue;

      const realDec = sourceResults.declarations.find(
        param => param.name === binding.name && param.kind !== "import"
      );

      if (!realDec) continue;
      realDec.uses.push(...binding.uses);
    }
  }

  // Step 3: move the declarations into a flat "nodes" array:
  // every declaration from every file, uses already attached.
  const graph: Graph = { root: projectDir, nodes: [], edges: [] };

  for (const fileResults of Object.values(treeResults)) {
    for (const declaration of fileResults.declarations) {
      // skip every non-declaration (use) role
      if (declaration.role !== "declaration") continue;

      // skip every node that has imports
      if (declaration.kind === "import") continue;

      graph.nodes.push({ ...declaration, id: nodeId(declaration.file, declaration.start) });
    }
  }

  // Step 4: read the feeds stamped on each use: the use's owning declaration is
  // the thing being used, and use.feeds names the declaration that use flows into.
  // Draw an edge owning declaration -> fed declaration for each one, keeping
  // every use site that contributed to it so clicking the edge can show the code.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgesByKey = new Map<string, GraphEdge>();
  for (const node of graph.nodes) {
    for (const use of node.uses) {
      if (!use.feeds) continue;
      // One use can feed several declarations — `const { a, b } = foo()`
      // reads foo once and flows into both — so this is a list, and each
      // entry becomes its own edge from the same use site.
      for (const fed of use.feeds) {
        const target = nodeId(fed.file, fed.start);
        // the fed declaration may have been filtered out (e.g. an import);
        // only keep edges where both ends are real graph nodes.
        if (!nodeIds.has(target)) continue;

        const key = `${node.id}->${target}`;
        let edge = edgesByKey.get(key);
        if (!edge) {
          edge = { source: node.id, target, occurrences: [] };
          edgesByKey.set(key, edge);
        }
        edge.occurrences.push({ file: use.file, line: use.line, code: codeAt(use.file, use.line) });
      }
    }
  }
  graph.edges.push(...edgesByKey.values());

  // Roll every file's lookup tally into one. Without this the counts stay
  // buried in each file's Results and the only way to read them is to attach
  // a trace hook and scrape the phase line, which is no way to watch a number
  // you want to treat as a regression signal.
  const lookups = { resolved: 0, unresolved: 0, external: 0 };
  for (const fileResults of Object.values(treeResults)) {
    lookups.resolved += fileResults.lookups.resolved;
    lookups.unresolved += fileResults.lookups.unresolved;
    lookups.external += fileResults.lookups.external;
  }

  return {graph, filesAnalysed: Object.keys(treeResults).length, lookups, skipped, unlinkedImports};
}