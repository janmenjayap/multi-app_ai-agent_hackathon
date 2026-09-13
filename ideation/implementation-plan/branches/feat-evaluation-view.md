# Branch: `feat/evaluation-view`

**Scope:** Add optional drilldowns from a measured cohort to its attempts, evidence gaps, and first-proposal quality.
**Owner:** P4 — frontend/evaluation owner.
**Priority:** P1 optional; defer explicitly if P0 evidence or recording would be delayed.

Use the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md)
for the required U02 boundary, drilldown hierarchy, saved-report rendering rules,
responsive/accessibility checks, and parallel file ownership.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [U03 — Add richer inspection of the measured scorecard [P1]](../commits/U03.md)
   Suggested subject: `feat(web): [U03] add measured scorecard inspection`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **U03:** [U02](../commits/U02.md), [Q05](../commits/Q05.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/langsmith-export`](feat-langsmith-export.md): separate owned paths; its own merge gates remain in force.
- [`feat/durable-recovery`](feat-durable-recovery.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

U03 renders saved Q05 counts and drills from M1-M7/critical counts to exact suite
entries, attempts, claims, labels, expected/observed fields and evidence references
without recomputing metrics. Preserve the full census, version/mode boundaries,
original-versus-corrected proposals and claim-time versus later-drift evidence.
Proof compares displayed values and authorized navigation to the exact saved
report, including zero labels, N/A, repeated claim IDs and failed/unrun slots.
Defer this branch if it delays P0 evidence; U02 still supplies the required basic
report surface.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Render server-supplied model/app evidence and missing coverage; do not call providers or models from the scorecard.

[U03](../commits/U03.md) defines the exact steps and checks. Read
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

