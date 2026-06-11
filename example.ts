// corpus.ts — every way a name is born
import { parse } from "acorn";                    // import

var a = 1;                                        // var
let b = 2;                                        // let
const c = 3;                                      // const

const { query, limit = 10 } = options;           // object destructuring + default
const [first, ...rest] = items;                  // array destructuring + rest

function f(x, y = 5, ...args) { return x; }      // declaration + simple/default/rest params
const g = (p) => p * 2;                          // arrow
const h = function (q) { return q; };            // function expression

function k({ url, depth }) {}                    // destructured param

for (const item of list) {}                      // for-of
for (const key in obj) {}                        // for-in
for (let i = 0; i < 3; i++) {}                   // classic for

try {} catch (err) {}                            // catch param

class Ranker {                                    // class
  score(result) { return result.value; }          // method + its param
}

enum Mode { Fast, Slow }                          // TS enum
interface Config { url: string }                  // TS interface
type Result = { score: number };                  // TS type alias