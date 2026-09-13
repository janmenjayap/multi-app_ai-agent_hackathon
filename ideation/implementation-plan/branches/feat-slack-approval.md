# Branch plan: feat/slack-approval

**Owner:** P1. **Status:** implemented and verified offline; live integration remains R01.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Bind a real Slack human decision to an exact immutable plan, review thread, source state and expiry; persist resumable waiting without granting authority to a client flag.

## Merge dependencies and exact commit order

External branch-entry gates: [B01](../commits/B01.md), [B03](../commits/B03.md), [B04](../commits/B04.md), [I04](../commits/I04.md).

1. [B05 — Bind Slack approval to the current plan and source state](../commits/B05.md).

All four external prerequisites must be on main before merge. Posting a review and entering the graph interrupt are distinct sequential steps.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with B07 readback implementation once its provider gates land, remaining provider work, agent modules, and evaluation/UI branches. P4 owns adversarial approval tests; P2 reviews Slack normalization on the separate adapter branch.

## Reliability merge handoff

[B05](../commits/B05.md) must authenticate actual provider observations as required by the [reliability plan](../06-agent-reliability-implementation.md): real actor, exact thread/workspace, current message integrity, plan hash/revision, expiry and complete source recheck. Imported flags and resume references provide no approval authority.

Hand B06 a server-owned receipt whose authority is revalidated before each mutation. Test approval edits/deletion between effects, correct text in the wrong thread, bot replies, stale source state and expiry at dispatch. Every invalid case has zero subsequent protected calls; Q02 independently collects Slack history later.

## Agent and external-app integration handoff

Use I04 for exact Slack review and fresh human-decision reads; consume refreshed I02/I03 source evidence before execution.

[B05](../commits/B05.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B05 approval/freshness/review/wait files and approval tests. Do not modify Slack adapter internals, shared schemas, execution files, packages, or migrations; adapter fixes merge through I04's owner before integration.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give B06 trusted decision references, source-freshness results, rejection/invalidation rules, and evidence that invalid replies never dispatch protected work. R01 proves the same behavior on the actual Slack thread.

## Branch completion receipt

- Implementation: `c6b8dcde61d7e997a22918730be2f396556a8268` on `feat/slack-approval`.
- Dependency-complete base: `04a58b1f801ed53b0a2a0af07cf1f53a538c6981`.
- All four prerequisites are merged; full SHAs, versions and exact commands are
  recorded in the [B05 receipt](../commits/B05.md#completion-receipt).
- 19 approval tests, 75 affected application regressions, 7 Slack adapter tests,
  typecheck and server/web build pass. Evidence is synthetic with durable receipts.
- P1/P2/P4 agent implementation and review joined; B06/R01 handoff is recorded.
  Live Slack and the assembled workflow remain unrun.
- Merge target: `main`; preserve the implementation SHA and both remote branches.
