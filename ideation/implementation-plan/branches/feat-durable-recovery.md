# Branch plan: feat/durable-recovery

**Owner:** P1. **Status:** proposed branch work; this file creates no branch or commit.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Optional priority-P1 enhancement: prove automatic completion after a remote write was accepted but local acknowledgement was lost. Owner P1 is the integrator; priority P1 means optional scope.

## Merge dependencies and exact commit order

External branch-entry gates: [R01](../commits/R01.md), [Q04](../commits/Q04.md).

1. [B08 — Demonstrate bounded automatic recovery after restart [P1]](../commits/B08.md).

R01 and Q04 are hard merge prerequisites. Run fake termination/restart tests before the isolated live interruption exercise; final graph integration and release freeze are sequential.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with Q05 measurement/label work, U03 richer scorecard, and Q06 trace export in their isolated files. P4 authors process-fault assertions while P2 prepares live-account observations; schedule these people explicitly rather than assuming extra staff.

## Reliability merge handoff

[B08](../commits/B08.md) remains the optional P1 enhancement in the [reliability plan](../06-agent-reliability-implementation.md). Preserve original evaluation identity, first outputs, pre-crash attempts and remote IDs; append runtime/boot recovery spans and independent adoption receipts.

Successful S4 recovery requires the same accepted draft/task/note IDs, no duplicates, a fully verified final state and the frozen recovery budget. Resumes are not new task-success/M4 denominator entries. Safe escalation, unavailable evidence or deferral remains explicit in Q05/R02 and cannot be relabeled as successful automatic recovery.

## Agent and external-app integration handoff

Reuse R01 clients and durable role/plan results; recovery cannot reset budgets, broaden MCP capabilities or regenerate approved text.

[B08](../commits/B08.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B08 recovery source, recovery-node registration, and scenario test. P1 is the sole editor of graph.ts; serialize graph changes with R01/R02. Driver/migration/shared-schema/package changes require owner follow-ups, and B06 uncertainty guards remain intact.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Rerun affected Q04 cases and Q05 metrics, preserve fake/live evidence separately, and hand the new SHA/evidence to R02 for a fresh release freeze. If cut, record B08 as deferred and omit automatic-S4-success claims while preserving required safe-stop behavior.

## Branch completion receipt

- [ ] Dependency SHAs and actual base SHA: `UNRECORDED`.
- [ ] Every linked commit receipt completed; actual commit SHAs: `UNRECORDED`.
- [ ] Combined verification commands/evidence and remaining gaps: `UNRECORDED`.
- [ ] Reviewer and consumer handoff acceptance: `UNRECORDED`.
- [ ] Actual merged branch/PR reference: `UNRECORDED`.
