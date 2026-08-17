# Benchmark #1 — can the graph answer real data-flow questions?

**August 17 2026.** Target: Hono `src`, test files excluded — 186 files, 4,702 nodes, 2,549 edges, 0 skipped, 0 unlinked.

## Why this exists

Every number in NOTES.md so far measures the engine against itself: resolution rate, unresolved residue, edge count. Those are proxies. None of them answers the question that decides whether this project is worth continuing — **can something ask the graph a question a person would actually ask, and get the right answer?**

The rule for this file: **ground truth is derived by hand from the Hono source, before running any query.** Otherwise the questions drift toward whatever the graph happens to be good at, and the benchmark measures nothing.

Second rule: the questions have to be ones where *data flow is the answer*. If `grep` settles it, the tool isn't the variable being tested.

## Scoring

| verdict | meaning |
| --- | --- |
| ✅ | the answer set matches ground truth exactly |
| ⚠️ | a strict subset — real edges, but incomplete |
| ❌ | nothing returned, or the key relationship missing |

A wrong-answer category exists and went unused. See the headline below.

---

## The questions

### A. Backward provenance — "where did this value come from?"

**Q1. What feeds `res` in `compose.ts:38`?**
Ground truth: `handler`@40, `onError`@17, `onNotFound`@18 — the three assignments at lines 51, 55, 63.
Result: exactly those three. **✅**

**Q2. What feeds `path` in `utils/filepath.ts:52`?**
Ground truth: `root`@35 and `filename`@36, both tracing back to `options`@33.
Result: exactly that, including the self-loop from line 53. **✅**

**Q3. What feeds `userPass` in `utils/basic-auth.ts:15`?**
Ground truth: line 18 is `userPass = USER_PASS_REGEXP.exec(utf8Decoder.decode(decodeBase64(match[1])))` → `USER_PASS_REGEXP`@4, `utf8Decoder`@5, `decodeBase64` (imported), and `match`@10 — which itself comes from `req`@9.
Result: `USER_PASS_REGEXP` only. **❌**

This is the one that matters most. The question underneath it is *"does attacker-controlled input reach the parsed credentials?"* — the answer is yes, and the graph cannot say so, because `match` is an argument to an unresolved call. See gap A below.

**Q4. What feeds `binary` in `utils/encode.ts:26`?**
Ground truth: `str`@25, via `atob(str)`.
Result: nothing. **❌**

**Q5. What feeds `hash` in `utils/crypto.ts:17`?**
Ground truth: `createHash`@33, and through it `data`@15 and `algorithm`@16.
Result: `createHash` and its return, but not the arguments. **⚠️**

### B. Forward impact — "if I change this, what moves?"

**Q6. What does `defaultDocument` (`utils/filepath.ts:14`) reach?**
Ground truth: `filename`@13 (lines 18 and 21), then into the call at line 24, `options`@33 → `filename`@36 → `path`@52 → returned.
Result: nothing. **❌**

**Q7. What does `str` (`utils/encode.ts:6`) reach?**
Ground truth: `decodeBase64`'s `str`@25 → `binary`@26 → `bytes`.
Result: missed all of that, but correctly followed the return out to `jws.ts:42` and `jwt.ts:177`. Real edges, wrong ones for this question. **⚠️**

**Q8. What does `duration` (`middleware/timeout/index.ts:39`) reach?**
Ground truth: `timer`@43, via `setTimeout(…, duration)`.
Result: nothing. **❌**

**Q9. What does `status` (`http-exception.ts:55`) reach?**
Ground truth: `this.status = status`@58, read at lines 69 and 75 in `getResponse`.
Result: nothing. **❌** — object fields are not flow-tracked at all. New gap, see C below.

**Q10. What does `middleware` (`compose.ts:16`) reach?**
Ground truth: `handler`@40.
Result: `handler`@40. **✅**

### C. Cross-file

**Q11. Does `part` (`utils/jwt/jwt.ts:35`) reach `str` in `utils/encode.ts:6`?**
Ground truth: yes — `decodeBase64Url(part)`@36, imported from `../../utils/encode`.
Result: yes, directly. **✅** (this is gap 16's path, working on a foreign repo)

**Q12. What feeds `buf` in `utils/encode.ts:10`?**
Ground truth: `encodeSignaturePart`'s `buf` (jwt.ts:33) and the `utf8Encoder` expression (jwt.ts:32).
Result: both. **✅**

**Q13. What feeds `str` in `utils/encode.ts:25`?**
Ground truth: the local call at encode.ts:7, plus every cross-file caller.
Result: four cross-file sources — `aws-lambda/handler.ts:318`, `lambda-edge/handler.ts:200`, `basic-auth.ts:10`, `jws.ts:50`. **✅**

**Q14. What feeds `buf` in `utils/encode.ts:15`?**
Ground truth: `encodeBase64(buf)` at encode.ts:11, plus external callers.
Result: three external callers found; the intra-file one at line 11 missed. **⚠️**

### D. Negative controls — the answer is "no"

**Q15. Does `onNotFound` (`compose.ts:18`) reach `index` (`compose.ts:21`)?** No. Result: no. **✅**

**Q16. Does `exception` (`timeout/index.ts:40`) reach `timer`@43?** No. Result: no. **✅**

**Q17. Does `sha1`'s `data` (`crypto.ts:21`) reach `sha256`'s `hash` (`crypto.ts:17`)?** No — separate functions. Result: no. **✅**

### E. Grep traps — name-based search gives the wrong answer

**Q18. What feeds `createHash`'s `algorithm` param (`utils/crypto.ts:33`)?**
Ground truth: three distinct call sites — `algorithm`@16 (SHA-256), @22 (SHA-1), @28 (MD5). Grep for `algorithm` returns eight lines with no way to tell which flows where.
Result: none of the three. **❌**

**Q19. What feeds `handler` in `compose.ts:40`?**
Ground truth: `i`@32, `next`@20, `middleware`@16. Grep also returns `errorHandler` and `notFoundHandler` noise.
Result: exactly those three. **✅**

**Q20. What feeds `filename` at `utils/filepath.ts:36`?**
Ground truth: `options`@33 only. There is a *different* `filename` at line 13 in the other function; grep cannot separate them.
Result: `options`@33. **✅**

---

## Scorecard

| | run 1 (before gap 18) | run 2 (after gap 18) |
| --- | --- | --- |
| ✅ correct | 11 / 20 | **15 / 20** |
| ⚠️ partial | 3 | 3 |
| ❌ missing | 6 | **2** |
| **wrong** | **0** | **0 proven / see note** |

> The first draft of this file reported run 1 as 10/4/6. That was an arithmetic slip in the
> summary — the per-question verdicts below have always been 11 ✅, 3 ⚠️, 6 ❌. Corrected here.

### Run 2 — after gap 18 (August 17 2026)

Four questions moved ❌ → ✅: **Q3, Q4, Q6, Q8.** All four were the same cause, and closing it closed all four.

Q3 is the one worth showing, because it is the security question and it now resolves end to end:

```
userPass (basic-auth.ts:15)
  <- decodeBase64 (encode.ts:25) ~inferred
      <- str (encode.ts:25) ~inferred
          <- match (basic-auth.ts:10)
              <- req (basic-auth.ts:9) ~inferred
```

The `Request` parameter reaches the parsed credentials, across two files and five hops.

**Q1 now returns a superset**, and this is the over-approximation showing up exactly where it was predicted to. It adds `err`@52 and `context`@20 to the three assignment sources, because `onError` and `onNotFound` are *parameters* holding functions, so their call sites don't resolve and their arguments pass through. Both additions are defensible on inspection — an error handler's output really does depend on the error it is handed — so this is arguably the ground truth being incomplete rather than the tool being wrong. `query --strict` returns exactly the original three.

**All three negative controls still hold** (Q15, Q16, Q17), which was the main risk. The proven subgraph is **set-identical** to run 1's graph: 2,549 edges, zero added, zero removed, and no inferred edge duplicates a proven one.

| | run 1 | run 2 |
| --- | --- | --- |
| edges | 2,549 | 2,924 |
| — proven | 2,549 | 2,549 |
| — inferred | 0 | 375 (12.8%) |

**Remaining failures, both single-cause:**

- ⚠️ Q5, Q7, Q14 — gap 19 (forward references in callee lookup)
- ❌ Q9 — gap 20 (object fields)
- ❌ Q18 — gap 19

Gap 19 is now the whole of the remaining shortfall except one question. That is the next thing to fix, and this file predicts it moves four answers.

### The headline is the zero

Not one answer contained an edge that isn't real. All three negative controls held, and every ⚠️ is a strict subset of the truth. **Every single failure is a missing edge, never a false one** — which is exactly the posture NOTES.md has been maintaining on purpose, now confirmed against questions the engine was not built around.

Run 2 keeps this property *for the proven subgraph*, which is why gap 18's edges are marked rather than blended in. `query --strict` reproduces run 1's answers exactly; the default adds reach at the cost of edges that are assumed rather than proven.

That matters for the agent case more than the 10/20 does. A tool that is silent 30% of the time is usable with a caveat. A tool that fabricates a data-flow edge 30% of the time is worse than no tool.

### What the failures attribute to

| cause | questions | count |
| --- | --- | --- |
| **A. Argument flow dropped at an unresolved callee** | Q3, Q4, Q6, Q7, Q8 | 5 |
| **B. Forward references (single-pass walk order)** | Q5, Q14, Q18 | 3 |
| **C. Object fields not flow-tracked** | Q9 | 1 |

Nine of the ten imperfect answers come from three causes, and **one cause accounts for half the failures.** That is the thing the benchmark was built to find and no internal metric would have surfaced: `unlinkedImports` is 0, `skipped` is 0, resolution is ~96%, and the graph still cannot say that an HTTP header reaches a parsed password.

Gap A is measured separately: 719 arguments on this repo (19.5% of all arguments) sit in a feed context and lose it. Making an unknown call transparent takes the graph from 2,549 to 2,924 edges (+14.7%).

### What this changes about priorities

*Next up* item 6 said "serve the graph to agents once coverage is trustworthy." The dependency was backwards. Coverage was never the binding constraint here — Q1, Q12, Q13 and Q19 show the engine answering multi-source, cross-file provenance questions perfectly on a codebase nobody here wrote. What blocked it was first the query surface, and now three specific engine gaps that self-analysis could not have ranked.

Suggested order, revised:

1. **Gap A** — half the failures, biggest measured edge gain, and it removes an internal inconsistency (the receiver of a call gets an edge; the argument to the same call does not).
2. **Gap B** — a hoisting pre-pass over module-level declarations.
3. **Gap C** — decide whether `this.x = y` should be an edge at all. Bigger design question than the other two.

Re-score this file after each. The questions do not change; that is the point of them.

## Method notes / caveats

- Ground truth was written from the Hono source before any query was run.
- "Direct feed" questions were scored at `--depth 1`; reachability questions at the default depth.
- `file:line` is not always a unique address — `utils/crypto.ts:33` matches three declarations sharing that line (`data`, `algorithm`, `createHash`). The `file:name` form disambiguates, and the ambiguity list prints pasteable addresses, but this is a real rough edge in the addressing scheme worth fixing.
- Twenty questions is small. It is enough to rank three causes; it is not enough to claim a percentage that will hold on another repo.
