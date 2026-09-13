# Branch: `feat/langsmith-export`

**Scope:** Optionally add navigable LangSmith diagnostics while local storage and measurement remain authoritative.
**Owner:** P4, or P2 after provider work — optional telemetry owner.
**Priority:** P1 optional; defer explicitly if P0 evidence or recording would be delayed.

The offline implementation is complete; see the [Q06 receipt](../commits/Q06.md#completion-receipt).
Live sandbox export and R01 composition remain separate gates. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q06 — Export sanitized traces to LangSmith without blocking work [P1]](../commits/Q06.md)
   Suggested subject: `feat(observability): [Q06] export sanitized traces without blocking execution`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q06:** [B01](../commits/B01.md), [Q03](../commits/Q03.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/evaluation-metrics`](feat-evaluation-metrics.md): separate owned paths; its own merge gates remain in force.
- [`feat/evaluation-view`](feat-evaluation-view.md): separate owned paths; its own merge gates remain in force.
- [`feat/durable-recovery`](feat-durable-recovery.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

Q06 is optional diagnostic export. Preserve actual run/span/tool-attempt/claim correlation through sanitized references, with durable bounded retries and explicit export status. Local runtime enforcement, independent outcome checks and human labels remain required with LangSmith disabled. Proof: redaction, duplicate delivery, outage/crash and identical local verdicts/denominators across enabled/disabled/failed export. No trace link closes an outcome gate by itself.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Export sanitized existing model/tool spans using optional server configuration; no new LLM or business-app call is introduced.

[Q06](../commits/Q06.md) defines the exact steps and checks. Read
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


## Offline implementation handoff — September 14, 2026

Q06 is implemented at `62c69ad7f41a28e6266e43ca67be438c93d66f06` under conventions 1.2, with
11 exporter tests, 23 storage/monitor tests, 133 baseline regressions, typecheck
and both builds passing. Delegated Codex reviewer `q06_review` accepted the
P1/P4 offline handoff. P1 supplied the missing outbox migration and corresponding
storage test adjustments; the [receipt](../commits/Q06.md#completion-receipt)
records the narrow exception, exact prerequisite SHAs and all failed/unrun checks.
R01 consumes the injected optional lifecycle; R02 must not claim live LangSmith
export or working hosted links until their currently unrun sandbox smoke passes.
