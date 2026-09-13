# Branch: `feat/scenario-harness`

**Scope:** Run the actual graph through frozen scenarios and produce independently assessed attempts instead of replaying prewritten synthetic event streams.
**Owner:** P4 — scenario harness owner, with P2/P3 fixture reviewers.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q04 — Automate scenario runs and classify faults honestly](../commits/Q04.md)
   Suggested subject: `test(scenarios): [Q04] execute frozen workflow and fault cohorts`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q04:** [R01](../commits/R01.md), [Q01](../commits/Q01.md), [Q02](../commits/Q02.md), [Q03](../commits/Q03.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/operator-console`](feat-operator-console.md): separate owned paths; its own merge gates remain in force.
- [`feat/langsmith-export`](feat-langsmith-export.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

Q04 executes the actual graph and joins evidence to Q01's whole frozen census. Mandatory preflight and independent S0 occur under `suiteEntryId` before registration; failed S0 is setup-failed in the census and excluded from M1/M7 attempts. Bind successful S0's hash at registration immediately before graph dispatch. All later faults remain attempted; never move the boundary retrospectively. Preserve unrun slots separately from registered/attempted records, including starts that never reach a result. Run first S1/S2/safe-block/stale-approval and tamper checks, then the 18 baselines, 42 baseline/repetition target and declared variants, with five live cases. Original outputs survive correction. Proof includes denominator stability on resume, preserved failed cases, absent labels, stalled starts and predeclared repair legs. R01 remains a hard prerequisite; drafting harness code earlier is permitted, but generated traces are not graph execution.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Exercise the R01 graph with explicit model/app configurations, role call-count/resume checks and provider failure/readback scenarios.

[Q04](../commits/Q04.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## Shared-file exclusions

- Use only the allowed paths in the linked commit guide(s).
- P1 owns root dependency/lock files, shared schemas, database migrations, and
  graph/API composition. Request an owned prerequisite change rather than
  privately modifying a shared contract or adding a dependency.
- Do not edit another branch's application modules, the root README, or Global Scale; supply evidence to P1 for the register update.
- Preserve `tools/reliability/`, the existing monitor behavior/tests, private
  local evidence, and user-owned moves under `ideation/exploration/`. No broad
  staging, cleanup, reset, or generated-evidence replacement belongs in this task.

## Merge handoff

- [ ] Base and hard prerequisite SHAs are linked in the PR.
- [ ] The commit order and exact suggested subject(s) have an actual SHA mapping.
- [ ] Allowed-file ownership and any prerequisite shared changes are reviewed.
- [ ] Tests, build checks, evidence mode, and failed/unrun cases are attached.
- [ ] The next consuming commit can use the documented contract unchanged.
- [ ] P1 records only demonstrated scope in [Global Scale](../Global%20Scale.md).
- [ ] Branch merge SHA / reviewer / evidence references: **pending**.

The current offline monitor baseline is reusable implementation, not proof of the
future app. Claim live behavior only when the commit-specific independent evidence
exists; otherwise leave its completion gate open.

