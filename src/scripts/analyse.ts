import { collectVariables } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Graph, GraphEdge, Results } from "./types";
import { resolve } from "path";

/**
 * Directories that are never the user's own source. Without this a plain
 * `flow .` walks node_modules and parses every dependency — in this repo
 * that's 496 of 505 matched files, and the resulting graph runs to gigabytes.
 */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor",
]);

/**
 * Determines if a given path (relative to `projectDir`) is a project source file
 * worth analyzing, by filtering out ignored directories and ambient type declaration files.
 *
 * @param {string} relativePath - The path relative to the project directory.
 * @returns {boolean} True if the file should be analyzed as project source, false otherwise.
 */
function isProjectSource(relativePath: string): boolean {
  if (relativePath.split("/").some((segment) => IGNORED_DIRS.has(segment))) return false;
  /**
   * Ambient type declarations: no runtime values, so no data flow to trace,
   * and they're the bulk of what ships inside packages.
   */
  if (relativePath.endsWith(".d.ts")) return false;
  return true;
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

export async function analyse(projectDir: string): Promise<{ graph: Graph, filesAnalysed: number }> {
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

  for await (const file of glob.scan(projectDir)) {
    // disregards non-project source files 
    // specified in the isProjectSource function
    if (!isProjectSource(file)) continue;
    // resolves the absolute path of the file
    const absolutePath = resolve(projectDir, file);
    // reads the file's text content
    const code = await Bun.file(absolutePath).text();
    // parses the file's code into an AST
    const tree = parse(code, { loc: true, range: true });
    // collects the variables in the AST
    // and stores the results in the treeResults object
    // format: {"some path": Results}
    treeResults[absolutePath] = collectVariables(tree, absolutePath);
    // stores the file's text content
    fileTexts[absolutePath] = code;
  }

  // Step 2: for each file, for each import declaration, find the real
  // declaration in the source file and move the uses onto it.
  for (const fileResults of Object.values(treeResults)) {
    for (const binding of fileResults.declarations) {
      // disregard non-import bindings
      if (binding.kind !== "import") continue;

      // assign the source of the import
      const sourceResults = treeResults[binding.source!];

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

  return {graph, filesAnalysed: Object.keys(treeResults).length};
}