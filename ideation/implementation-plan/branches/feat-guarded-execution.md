# Branch plan: feat/guarded-execution

**Owner:** P1. **Status:** proposed branch work; this file creates no branch or commit.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Enforce approval/freshness, atomically claim effects, persist intent, and reconcile uncertain writes before any further create. Mandatory safe uncertainty handling is independent of optional automatic recovery.

## Merge dependencies and exact commit order

External branch-entry gates: [B01](../commits/B01.md), [B03](../commits/B03.md), [B05](../commits/B05.md), [I02](../commits/I02.md), [I03](../commits/I03.md), [I05](../commits/I05.md).

1. [B06 — Guard and reconcile every protected effect before dispatch](../commits/B06.md).

Development can overlap B07; actual task → note → draft → comment writes and their verifications remain sequential in the assembled workflow.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with feat/readback-verifier, Q02/Q03 collection/monitor integration, agent roles and U02 once their gates permit. P4 can author race/fault tests independently; P3 supplies the verifier contract without editing executor files.

## Reliability merge handoff

[B06](../commits/B06.md) joins each actual call to an immutable plan, fresh authentic approval/source receipts, persisted exact intent, provider attempt and verification record. ApprovedContentRef resolves only from the plan's frozen content; EffectIdRef resolves through independent declared ID bindings, never arbitrary provider text. The [reliability plan](../06-agent-reliability-implementation.md) requires transport/provider/application outcomes and retry/settling schedules to remain distinct.

Prove no dispatch after failed persistence/authority checks and no second create after uncertain acceptance. Keep partial/unknown effects and original IDs visible; require verification before the next protected effect. Q03 consumes the canonical execution trace; Q02 uses stable markers to collect independent observations. B08 automatic completion remains optional, while reconciliation-or-stop is mandatory here.

## Agent and external-app integration handoff

Dispatch I03 task/note, I05 draft and I02 comment operations under approval; reconcile unknown writes before any create.

[B06](../commits/B06.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B06 execution files and its test. Keep approval/storage/provider implementations and graph composition with their owners. Do not change shared contracts, migrations, root packages, or the independent evaluation oracle from this branch.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give R01 an executor with injected verification, ordered requests, stable effect/attempt references, and no-second-create proof under accepted-write uncertainty. B08 may later add automatic restart completion without weakening these guards.

## Branch completion receipt

- [ ] Dependency SHAs and actual base SHA: `UNRECORDED`.
- [ ] Every linked commit receipt completed; actual commit SHAs: `UNRECORDED`.
- [ ] Combined verification commands/evidence and remaining gaps: `UNRECORDED`.
- [ ] Reviewer and consumer handoff acceptance: `UNRECORDED`.
- [ ] Actual merged branch/PR reference: `UNRECORDED`.
