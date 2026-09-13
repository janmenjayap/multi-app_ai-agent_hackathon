# Branch plan: feat/durable-core

**Owner:** P1. **Status:** B01 implemented, reviewed and merged; see the receipt below.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Add authoritative application persistence while reusing the standalone monitor's evidence/job tables. The required join is application transition + canonical event + measurement job in one transaction on the same application SQLite connection.

## Merge dependencies and exact commit order

External branch-entry gates: [F02](../commits/F02.md).

1. [B01 — Persist authoritative application state and evidence atomically](../commits/B01.md).

Use one application database for the atomic join; preserving the standalone monitor CLI does not justify a second authoritative event/job writer.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

After F02, overlap with feat/selection-policy when Q01 is ready, feat/adapter-core
and provider branches, feat/evaluation-fixtures, and feat/operator-console.
Check each companion's own prerequisite sheet; overlap means separate owned files,
not waived gates. The agent runtime's A01 depends on B01 and cannot merge first.

## Reliability merge handoff

Implement the storage acceptance section in [B01](../commits/B01.md) against the [reliability plan](../06-agent-reliability-implementation.md). Preserve first raw model outputs and source digests, authentic approval/provider receipts, exact dispatch intents, observations and scoped claims. Each application transition, canonical event and assessment job must commit in one SQLite transaction.

Require all-or-none crash receipts for waiting, failed, partial and completed states, plus immutable history across reopen and migration. A predispatch persistence failure prevents the external call; an interrupted call remains unresolved. Q03 receives the transaction-scoped writer and durable cursor; A01/B04–B07 consume that same reviewed seam.

## Agent and external-app integration handoff

Persist role claims, raw outputs, app requests and effect outcomes so A01 and I01–I05 can record real calls durably.

[B01](../commits/B01.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

This branch owns application storage/migrations and transaction-scoped observability writers. Coordinate the narrow MonitorStore transaction refactor and store regression edits with P4. Shared types/package files require a foundation follow-up; graph checkpoints remain separate and are implemented by B04.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give B04/B05/B06/B07/Q03 the transaction API, migration path, preserved monitor compatibility, and all-or-none state/event/job evidence. A separate asynchronous append into a monitoring database does not satisfy this branch.

## Branch completion receipt

- [x] Dependency: F02 `87d3c7d7bad17d54300e452e932c7f226fc74299`;
  base: `7ee74a7c651a9aee9efd7928c784cf7525efbb3b`.
- [x] B01: `472da5f33acca1e416af95c8fde6bad79a413c59`.
- [x] Typecheck/build, eight storage tests, 133 monitor/checker regressions,
  and synthetic SIGKILL/reopen checks passed. See the
  [full B01 receipt](../commits/B01.md#completion-receipt).
- [x] Delegated storage/monitor/event reviewers accepted; P1 accepts the seam
  for downstream integration under conventions 1.2.
- [x] Merge commit: `8bbf132c9b2b62fa83a5a21c347d451379cd2350`.

No provider/model or integrated workflow capability is claimed by this merge.
