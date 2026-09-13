# Branch: `feat/evaluation-fixtures`

**Scope:** Give parallel implementations a shared, independently fixed world and fault contract for the 18 scenario families.
**Owner:** P4 — independent fixture/evaluation owner.
**Priority:** P0 application delivery.

This guide proposes future work. No branch, commit, or provider action is created
by this document. Preserve the existing monitor through [P00](../commits/P00.md)
and follow the [canonical commit plan](../04-commit-plan.md).

## Exact commit order

1. [Q01 — Freeze scenario worlds, expected outcomes, and controllable fakes](../commits/Q01.md)
   Suggested subject: `test(evaluations): [Q01] freeze scenario oracles and stateful fakes`.

Keep each implementation with its tests. Do not reorder commits to hide a missing
prerequisite. A small PR can contain this single commit once its gates and verification pass.

## Base and merge gates

Start from reviewed `main` containing P00 and the first commit's hard prerequisites.
Record the base SHA in the PR. Earlier coding can use frozen contract fixtures on
a draft branch, but merge only after the exact required implementations land.

- **Q01:** [F02](../commits/F02.md).

Rebase/update from reviewed `main` after prerequisites merge, preserve teammate
changes, rerun affected checks, and merge sequentially through P1. A dependency
on a module is also a dependency on its tested contract, not just its filename.

## Compatible parallel work

- [`feat/durable-core`](feat-durable-core.md): separate owned paths; its own merge gates remain in force.
- [`feat/adapter-core`](feat-adapter-core.md): separate owned paths; its own merge gates remain in force.
- [`feat/operator-console`](feat-operator-console.md): separate owned paths; its own merge gates remain in force.

Compatible means independent coding/review, not permission to bypass prerequisite
merges or run conflicting live tests. See each commit's file assignments and
sequential join. Shared test-account namespaces and resets must be serialized;
isolated fixtures can run independently.

Follow the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md)
for the Q01/U01 boundary. After F02, Q01 and U01 are siblings: Q01 owns canonical
scenario/oracle identities and stateful model/provider fakes; U01 owns browser-
only state fixtures. They may progress in parallel and reconcile IDs through a
reviewed handoff without importing unmerged files or adding a U01 merge gate.

## Reliability implementation and proof

Q01 freezes the full planned census and logical manifest before execution, using `EffectIdRef` for objects whose provider IDs do not exist yet. `ApprovedContentRef` separately binds generated exact bytes from B03's immutable approved plan before dispatch; pre-run source facts and semantic invariants remain fixed and independently reviewed. Unique observed bindings later resolve object references without deriving expected content from provider output. Include `no_affected` manifests that require complete source/selection and zero writes, with no plan/approval/Slack requirements. Source facts and expected claims are independently reviewed; model/provider fakes expose real state and named faults rather than copying expectations into observed fields. Proof: reject mutable oracles, incomplete artifacts, omitted slots and ambiguous bindings; do not report 42 planned slots as attempts.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Agent and external-app integration handoff

Provide the injected model fake and independent stateful app fakes; freeze separate model/app configurations before execution.

[Q01](../commits/Q01.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

Hand U01 reviewed S1 golden-path, S2 replay, S3 safe-block and named-fault
scenario/evidence identities with explicit synthetic mode. This handoff may
replace identifiers in browser fixtures, but it cannot rewrite UI state semantics
or make a rendered fixture into executed scenario evidence.

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

