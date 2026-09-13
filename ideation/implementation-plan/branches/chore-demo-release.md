# Branch: `chore/demo-release`

**Scope:** Freeze the actual release, compare every claim with code and evidence, and package a reproducible demo and reliability brief.
**Owner:** P1 — release owner; P4 — demo/documentation owner.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [R02 — Freeze the release, verify completion, and package the evidence](../commits/R02.md)
   Suggested subject: `docs(release): [R02] freeze verified scope and delivery evidence`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **R02:** [R01](../commits/R01.md), [U02](../commits/U02.md), [Q04](../commits/Q04.md), [Q05](../commits/Q05.md). Also [B08](../commits/B08.md), [U03](../commits/U03.md), or [Q06](../commits/Q06.md) when included in release claims.

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- After release freeze, no parallel feature branch may modify the release. P4 can prepare the brief/recording while P2 checks access and P3 reviews labels; P1 owns final regression and the evidence register.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.
Optional B08/U03/Q06 work must finish and be retested before its capabilities enter the frozen release. If omitted, preserve the simpler release and disclose the omission.

## Reliability implementation and proof

R02 packages a reviewed claim-to-evidence map across original AI quality, runtime/traces and expected-versus-actual provider state. Include source/evaluator versions, census/attempt IDs, M1–M7 denominators, human reasons, claim-time coverage and failed/unrun cases. A zero v1 premature counter or zero labels cannot close the reliability gate. Close G1–G6 individually only with actual receipts; a narrower first demo leaves full-suite G5 visibly open. Optional exporter/richer UI/recovery claims wait for their own tests.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Record actual model/app configuration, smokes and combined live evidence; keep MCP unclaimed unless independently qualified.

[R02](../commits/R02.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## Shared-file exclusions

- Use only the allowed paths in the linked commit guide(s).
- P1 owns root dependency/lock files, shared schemas, database migrations, and
  graph/API composition. Request an owned prerequisite change rather than
  privately modifying a shared contract or adding a dependency.
- R02 explicitly owns the listed root README and Global Scale updates under P1. It does not change implementation code to manufacture a passing report.
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

