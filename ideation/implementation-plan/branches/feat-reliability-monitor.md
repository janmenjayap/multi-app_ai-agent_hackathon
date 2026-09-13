# Branch: `feat/reliability-monitor`

**Scope:** Connect the existing offline monitor to real application events without losing its persistence, retry, or measurement semantics.
**Owner:** P4 — monitor integration owner; P1 owns storage transaction integration.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q03 — Assess local events with durable measurement jobs](../commits/Q03.md)
   Suggested subject: `feat(monitoring): [Q03] integrate durable assessments with application events`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q03:** [B01](../commits/B01.md), [Q01](../commits/Q01.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.
B01's same-database application transition/event/job transaction bridge must already be merged. A separate monitor database append after the application commit cannot satisfy Q03's durability gate.

## Compatible parallel work

- [`feat/evidence-collector`](feat-evidence-collector.md): separate owned paths; its own merge gates remain in force.
- [`feat/readback-verifier`](feat-readback-verifier.md): separate owned paths; its own merge gates remain in force.
- [`feat/operator-console`](feat-operator-console.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

Q03 owns `assess.ts`, proposed `claim-verdicts.ts`, and their tests alongside worker integration. F02/Q01 freeze observation schema v2; planned `monitor-v2` preserves historical v1 semantics. Each success has a stable `claimId`; independent verdicts are confirmed/contradicted/unverified. `outcomeContradictedCompletionClaims` contains contradicted claims only. The `no_affected` scope needs complete source/selection, zero eligible commitments and no protected writes, without planRef/approval/Slack artifacts. `falseCompletion` unions premature and outcome-contradicted claim IDs once, while later drift is separate. Q05 aggregates these verdicts only. Q02 is an interface dependency during development and joins at R01; absent bundles remain unverified. Proof: single-transaction rollback/restart, missing evidence/labels, wrong actual fields despite `matches: true`, duplicate claims, overlapping violations and uncertain timing.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Consume real model/tool events and independently collected provider state; the monitor starts no agents or app mutations.

[Q03](../commits/Q03.md) defines the exact steps and checks. Read
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

