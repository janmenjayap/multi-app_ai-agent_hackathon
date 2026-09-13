# Reliability monitor verification receipt

**Recorded:** September 14, 2026, 00:31:16 IST / September 13, 19:01:16 UTC.
**Scope:** standalone offline monitoring of supplied observations.
**Revision:** working-tree implementation on base commit
`ba374912aec1f986ca3c89ba603ebeed60586005`; this base commit alone does not
contain the monitor. [validation.sha256](validation.sha256) identifies the exact
source, configuration, tests, preserved checker, and saved report used here.
It excludes unrelated ideation file moves and is a reproducibility fingerprint,
not an authenticated provider receipt.

## Toolchain and commands

Node **24.21.0**, built-in `node:sqlite`, Zod **4.6.4**, TypeScript **7.0.2**,
and `@types/node` **24.13.4**. The Node distribution was checked against its
official published SHA-256 checksum. Dependency installation from the repository
lockfile succeeded using the populated local npm cache:

```bash
npm ci --offline --cache /tmp/promiseguard-npm-cache --no-audit --no-fund
npm run typecheck
npm run build
node --test --test-isolation=none --test-reporter=tap tests/reliability/check-evidence.test.mjs tests/monitoring/*.test.mjs
node tools/reliability/check-evidence.mjs tools/reliability/examples/happy-path.synthetic.json
```

All commands exited **0**. Node 24 was placed on `PATH` for npm; the test and
checker invocations used that runtime's absolute path. The full test invocation
used approved subprocess access because the restricted sandbox blocks the real
CLI child-process tests. Earlier sandbox failures are not counted as passes.
For a fresh machine, use ordinary `npm ci`; the cache path above is only this
execution environment's install receipt. `npm test` builds and runs the same
checker/monitor test files.

## Observed results

- **129/129 tests passed**, with zero failures, cancellations, skips, or TODOs.
- **95 monitor tests:** 58 assessment, 8 contract, 10 metric, 9 pipeline/CLI,
  and 10 storage tests. They cover malformed and weakened contracts, approval
  and payload binding, independent read order, uncertain writes, causal recovery,
  failed-job exhaustion, leases, persistence, deduplication, denominators,
  censored latency, and separate final-versus-first-proposal quality.
- **34 preserved checker tests** passed; the checker executable, test source,
  and original synthetic input retain their historical SHA-256 hashes.
- **115/115 original checker assertions** passed on its one synthetic example.

The [saved CLI report](examples/synthetic-report.json) came from a fresh local
database using `node dist/server/monitoring/cli.js demo --db FILE`. The worker
processed one job, with zero failures or exhausted jobs. A second identical demo
processed zero jobs and retained exactly one evaluation attempt, with identical
assessment and metric groups after reopening the database.

That generated fixture reports M1 **1/1**, M2 **12/12**, M3 **42/42** predicates
and **6/6** mutation acknowledgements, M5 **0/5** excess creations, and M7 **1/1**
for each of the three declared roles. M4 has **0/0** eligible recoveries, so its
rates are `null`. M6's **3,900 ms** comes from generated event timestamps; it is
not an observed application runtime. The synthetic first-proposal labels marked
`human` are fixture records, not actual reviewer judgments.

## Boundaries and reproduction

**Actual application attempts: 0. Model calls: 0. Live provider workflows: 0.
Actual human semantic reviews: 0.** These tests exercise the monitor's code and
supplied event contracts. They do not establish the full 18-family application
suite, connected-account provenance, runtime enforcement, provider/MIME
collection, LangGraph integration, operator UI, or LangSmith export.

From the repository root, verify the tested input identity with:

```bash
sha256sum -c tools/monitoring/validation.sha256
```

Use the [monitor guide](README.md) to register your own frozen manifests, append
observations, and run measurement. Use [Global Scale](../../ideation/implementation-plan/Global%20Scale.md)
for remaining capability gates. Any source or contract change requires a new
receipt before inheriting these results.
