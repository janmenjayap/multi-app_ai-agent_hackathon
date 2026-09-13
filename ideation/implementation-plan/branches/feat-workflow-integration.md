# Branch: `feat/workflow-integration`

**Scope:** Join the separate modules into one deterministic application path and establish actual S1/S2 evidence.
**Owner:** P1 — sole graph/composition integrator.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [R01 — Assemble the guarded graph and prove the first vertical slice](../commits/R01.md)
   Suggested subject: `feat(workflow): [R01] compose guarded four-app execution`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **R01:** [B02](../commits/B02.md), [B03](../commits/B03.md), [B04](../commits/B04.md), [B05](../commits/B05.md), [B06](../commits/B06.md), [B07](../commits/B07.md), [I02](../commits/I02.md), [I03](../commits/I03.md), [I04](../commits/I04.md), [I05](../commits/I05.md), [A02](../commits/A02.md), [A03](../commits/A03.md), [A04](../commits/A04.md), [Q01](../commits/Q01.md), [Q02](../commits/Q02.md), [Q03](../commits/Q03.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.
P1 is the sole graph/composition owner. Live integration waits for every listed guard, provider, role, verifier, collector, and monitor prerequisite.

## Compatible parallel work

- [`feat/operator-console`](feat-operator-console.md): separate owned paths; its own merge gates remain in force.
- [`feat/scenario-harness`](feat-scenario-harness.md): separate owned paths; its own merge gates remain in force.
- [`feat/langsmith-export`](feat-langsmith-export.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

Follow the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md)
for the R01/U02 handoff. R01 and U02 may progress in separate files after their
own prerequisites, but R01 owns the real graph-to-F02 projection proof and U02
owns rendering/polling. Neither branch edits the other's implementation or claims
the other's acceptance evidence.

## Reliability implementation and proof

R01 joins the controlled graph, durable transaction/event producer, real agents, authenticated approval, B07 readback, Q02 collector and Q03 v2 assessor. This is where the optional collected-evidence interface becomes a real independently populated integration. Before registration, tools/demo/run.ts completes mandatory preflight/S0 under suiteEntryId; registration binds that S0 hash immediately before graph dispatch. It accepts minimal trusted human-review receipts through F02/B01 before Q05's richer workflow exists, preserving actual reviewer identity/reason and original source/output digests. Synthetic human-label JSON cannot pass as review. Bind generated exact content through B03 ApprovedContentRef before dispatch. Preserve original proposals and claim IDs, then prove all five S1 artifacts and S2 ID reuse with separate provider reads. Complete zero-eligible selection uses no_affected evidence without plan/approval/Slack dependencies. Missing labels or collector coverage stay unverified. R01 does not depend on Q04/Q05; it hands the tested invocation seam to their full harness/report work.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Own composition.ts, graph.ts and nodes.ts: construct A01/I01–I05 clients, invoke three roles, then wire approval, effects, readback and separate collection.

[R01](../commits/R01.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

Hand U02/R02 saved F02-valid run/event projections for S1, replay, approval wait,
safe block, failed partial and completed-but-unverified paths. Stage, model/tool
attempt, effect and readback IDs must match stored events, and deterministic
controls must not appear as extra agents. These projections are API evidence,
not proof that the browser rendered or refreshed them correctly.

## Shared-file exclusions

- Use only the allowed paths in the linked commit guide(s).
- P1 owns root dependency/lock files, shared schemas, database migrations, and
  graph/API composition. Request an owned prerequisite change rather than
  privately modifying a shared contract or adding a dependency.
- R01 explicitly owns its listed graph/composition/index files; upstream adapters, policies, agents, and storage remain with their respective owners.
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

