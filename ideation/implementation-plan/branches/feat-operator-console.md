# Branch: `feat/operator-console`

**Scope:** Make the incident, selected promises, exact draft, and run state reviewable on one operator screen before live API wiring. Replace fixture transport with the backend API while keeping approval in Slack and persisted business work independent of browser lifecycle.
**Owner:** P4 — frontend/evaluation owner.
**Priority:** P0 application delivery.

Use the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md)
as this branch's canonical screen hierarchy, pipeline semantics, state matrix,
responsive/accessibility contract, browser-test plan, and file-conflict review.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [U01 — Build one fixture-backed operator screen](../commits/U01.md)
   Suggested subject: `feat(web): [U01] add fixture-backed operator console`.

2. [U02 — Connect durable status, Slack review, and partial-run controls](../commits/U02.md)
   Suggested subject: `feat(web): [U02] connect durable run status and Slack review`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. U01 can merge in a small PR as soon as F02 is ready; U02 follows in a later PR on this same canonical branch after B04. Do not make U01 wait for B04.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **U01:** [F02](../commits/F02.md).
- **U02:** [U01](../commits/U01.md), [B04](../commits/B04.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/agent-analyst`](feat-agent-analyst.md): separate owned paths; its own merge gates remain in force.
- [`feat/gmail-adapter`](feat-gmail-adapter.md): separate owned paths; its own merge gates remain in force.
- [`feat/reliability-monitor`](feat-reliability-monitor.md): separate owned paths; its own merge gates remain in force.
- [`feat/readback-verifier`](feat-readback-verifier.md): separate owned paths; its own merge gates remain in force.
- [`feat/evidence-collector`](feat-evidence-collector.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

Inside U01, evidence/plan components, pipeline/effect components, and state/
accessibility tests may proceed in disjoint files after F02 shapes freeze; P4
alone joins `App.tsx` and shared styles. Q01 may supply canonical scenario
snapshots in parallel but is not a U01 merge gate. Inside U02, the API client,
run hook, controls/summary, and browser contract tests may overlap after B04
semantics freeze; P4 joins them without changing server truth or report arithmetic.

## Reliability implementation and proof

U01 first establishes the complete synthetic state/error matrix; U02 later binds
B04 transport and must expose the compact saved reliability summary. Show product
state, trace/process assessment, independent expected/actual state and original
proposal quality separately, including completed-but-unverified, failed-partial,
zero-label, 0/0, stale, offline and unavailable-report cases. U02 consumes an
optional F02 report projection and may merge before Q05; missing reports are
unavailable, not invented. Q05 joins by R02 for actual basic scorecard evidence.
No client approval/provenance authority is added, and U03 remains optional.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Use fixtures then backend HTTP status/commands; browser code has no model, provider or MCP client/credential.

[U01](../commits/U01.md), [U02](../commits/U02.md) defines the exact steps and checks. Read
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

