# Branch: `feat/evidence-collector`

**Scope:** Replace caller-invented snapshots with independently collected, complete scoped observations and feed them through the existing checker compatibility path.
**Owner:** P4 — evidence collector owner, with P2 provider support.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q02 — Collect independent scoped evidence and export checker input](../commits/Q02.md)
   Suggested subject: `feat(evaluations): [Q02] collect independent scoped provider evidence`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q02:** [Q01](../commits/Q01.md), [I02](../commits/I02.md), [I03](../commits/I03.md), [I04](../commits/I04.md), [I05](../commits/I05.md), [B01](../commits/B01.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/readback-verifier`](feat-readback-verifier.md): separate owned paths; its own merge gates remain in force.
- [`feat/reliability-monitor`](feat-reliability-monitor.md): separate owned paths; its own merge gates remain in force.
- [`feat/operator-console`](feat-operator-console.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

## Reliability implementation and proof

Q02 supplies independent paginated S0/S1 and history, actual MIME/associations/linked target fields, immutable logical-to-provider bindings, completeness and time windows. S0 collection is mandatory setup under `suiteEntryId` before registration; failures are setup-failed census gaps, and successful S0 hashes bind when the graph attempt registers. Resolve `ApprovedContentRef` from B03's already-frozen pre-dispatch plan receipt; provider-observed bytes never define expectations. Controlled ingest attaches provenance; callers cannot upgrade synthetic/imported data by changing `mode`. Q03 develops against the frozen optional bundle interface while these readers are built. R01 is the hard join for actual collection; no Q03-to-Q02 prerequisite cycle is introduced. Proof: page-two failure, forged provenance/digests, wrong recipient, missing draft, phantom Slack, unavailable sent history and ambiguous claim-time evidence all prevent full outcome credit.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Inject separate I02–I05 readers and retain app/account/transport/timing provenance, without adopting worker responses.

[Q02](../commits/Q02.md) defines the exact steps and checks. Read
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

