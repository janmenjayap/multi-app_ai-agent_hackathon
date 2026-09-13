# Branch plan: feat/workflow-driver

**Owner:** P1. **Status:** implemented and verified; user-authorized main integration.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Add durable application command acceptance, scheduling, waiting/restart, authenticated run APIs, and a separate graph checkpointer. The monitoring worker remains measurement-only.

## Merge dependencies and exact commit order

External branch-entry gates: [B01](../commits/B01.md).

1. [B04 — Drive one durable graph invocation per incident](../commits/B04.md).

Create responses only after command persistence. Fake injected driver nodes must stay explicitly simulated until R01 integrates real behavior.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with B02/B03 policy work, provider adapters, agent modules, Q02/Q03
evaluation integration, and U01 fixtures as their own gates permit. Follow the
[frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md):
P4 may own API projection/revision/cursor/redaction tests while P1 owns driver,
state, checkpoint and route code. U01 and B04 work concurrently, then join at U02.

## Reliability merge handoff

[B04](../commits/B04.md) produces real stage/span and lifecycle evidence under the [reliability plan](../06-agent-reliability-implementation.md): UTC/monotonic timing, canonical runtimeAttemptId, distinct modelAttemptId/providerAttemptId, causal restart links, durable retry/wait deadlines and state/event/job transactions. Explicitly map legacy attemptId and reject conflicts. Every waiting, blocked, failed, partial, completed and stalled path schedules assessment.

Artifact-producing run completion references a stable claimId/scope, approved plan and B07 final-Slack verification. completed_no_affected_commitments uses typed no_affected scope with complete source/empty-selection/absence receipts, no planRef and no final Slack requirement. Replayed status reads do not create new successful attempts. Q03 receives actual events; R01 supplies the graph. Test both completion types, incomplete-source false emptiness and durable invocation/event/job behavior.

## Agent and external-app integration handoff

Schedule the injected R01 graph outside HTTP and reuse completed role results through approval waits and restarts.

[B04](../commits/B04.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B04 driver/API/checkpoint files and its two test files. Do not edit graph business-node composition reserved for R01, provider adapters, shared types, migrations, or root package files without coordinated follow-ups. U02 consumes the HTTP contract rather than editing backend internals.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give B05 the persisted wait/resume seam; U02 receives authenticated routes,
monotonic revisions, reconnect-safe cursors, stable errors, redacted projections
and pending/unverified/unavailable measurements matching F02 examples. R01
receives dependency-injected graph composition hooks. Include concurrent-command,
restart, stale-response, session-expiry, monitor-outage and CSRF/access results.

## Branch completion receipt

- [x] B01 prerequisite: `472da5f33acca1e416af95c8fde6bad79a413c59`; base: `e27ee70ce85143a58ae73ce604afcf4be76f12a6`.
- [x] B04 implementation and tests: `7b13aa0b15c558526bfe9a25c15cf1649f101f14`; detailed receipt in [B04](../commits/B04.md).
- [x] 29 focused tests, typecheck, and build pass on the integrated base; synthetic evidence and remaining R01/live gates recorded in B04.
- [x] Delegated storage and API reviewers accepted the boundaries; B05/U02/R01 integration remains downstream.
- [x] Reviewed feature reference: `feat/workflow-driver`; user-authorized merge destination: `main`. Git history records the merge commit.
