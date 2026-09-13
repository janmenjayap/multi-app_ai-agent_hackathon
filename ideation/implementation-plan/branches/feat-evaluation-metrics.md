# Branch: `feat/evaluation-metrics`

**Scope:** Connect independently labeled application outputs and collected evidence to the existing M1–M7 engine and publish a reproducible measured report.
**Owner:** P4 — independent labels and metric integration owner.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q05 — Produce labeled quality results and reproducible metrics](../commits/Q05.md)
   Suggested subject: `feat(evaluations): [Q05] report labeled workflow cohorts with preserved metrics`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q05:** [Q02](../commits/Q02.md), [Q03](../commits/Q03.md), [Q04](../commits/Q04.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/langsmith-export`](feat-langsmith-export.md): separate owned paths; its own merge gates remain in force.
- [`feat/durable-recovery`](feat-durable-recovery.md): separate owned paths; its own merge gates remain in force.
- [`feat/evaluation-view`](feat-evaluation-view.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

Q05 extends R01's minimal F02/B01 trusted human-review receipt input with richer label intake plus aggregation/reporting; it does not own claim verdict logic. Mandatory pre-registration S0/preflight failures remain setup-failed census gaps, while post-registration faults stay attempted. Reviewers label original source/output digests with claim-level reasons and preserve corrections/superseded labels. Join the complete census, retain failures and unrun cases, report raw M1–M7 denominators and null rates, and separate v1/v2 cohorts. Consume Q03's distinct premature, outcome-contradicted, deduplicated false-completion and unverified sets. Proof: hand-computed overlap/zero-label/correction/censored cohorts and report reproducibility. A first fixed draft may complete M1 while remaining an M7 failure.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Review immutable original model outputs and aggregate independently observed app results, with separate provenance and no required evaluator LLM.

[Q05](../commits/Q05.md) defines the exact steps and checks. Read
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

