// A file for just logging the tree to the console.
import { parse } from "@typescript-eslint/typescript-estree";
import { collectVariables } from "./engine";

const FILE = "example.ts";
const code = await Bun.file(FILE).text();

const tree = parse(code, { loc: true });
console.log(JSON.stringify(tree, null, 2));