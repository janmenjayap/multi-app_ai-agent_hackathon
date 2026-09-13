# Branch plan: feat/readback-verifier

**Owner:** P3. **Status:** proposed branch work; this file creates no branch or commit.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Use actual fresh provider reads to verify the five artifact kinds, then finish Slack coordination and read back that summary before whole-run completion.

## Merge dependencies and exact commit order

External branch-entry gates: [B01](../commits/B01.md), [I02](../commits/I02.md), [I03](../commits/I03.md), [I04](../commits/I04.md), [I05](../commits/I05.md).

1. [B07 — Verify remote artifacts independently and finalize cautiously](../commits/B07.md).

B06 is not a hard B07 merge dependency: build against F02 interfaces. The assembled R01 path is where executor/readback/finalization must pass together.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with feat/guarded-execution, agent modules, UI and Q02/Q03 after their gates. P4 owns independent tampering tests; P2 reviews provider-specific field normalization without editing verifier source files.

## Reliability merge handoff

[B07](../commits/B07.md) is the inline completion gate; Q02 separately collects evaluation S0/S1 under the [reliability plan](../06-agent-reliability-implementation.md). Preserve actual read windows, completeness and raw-response digests. Resolve EffectIdRef from independent unique identity reads and ApprovedContentRef only from the immutable approved plan, retaining its content receipt and the pre-run semantic oracle. Verifier read clients have no write authority; finalization uses only narrow guarded Slack coordination.

Every success claim has a stable claimId, canonical runtimeAttemptId, scope, emission position and verification references. Artifact-scope success can precede Slack finalization; artifact-producing run completion follows Slack readback. Typed no_affected instead needs complete source/empty-selection/absence evidence, no planRef and no final Slack artifact. Stale/missing/wrong/cross-run evidence prevents the applicable completion. Later drift without claim-time evidence is not automatically false at emission.

## Agent and external-app integration handoff

Read artifacts freshly through I02–I05, then publish/read the I04 summary; keep Q02 evaluation reads independent.

[B07](../commits/B07.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B07 verification/readback/finalize files and its test. Do not modify executor return values to make assertions pass, the checker, frozen expected manifests, adapters, shared contracts, migrations, or root dependencies.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give R01 the read-only verification interface, persisted observations, exact artifact predicates, and cautious finalization behavior. Share normalization assumptions with Q02 while keeping the evaluation collector independent of worker success flags.

## Branch completion receipt

- [ ] Dependency SHAs and actual base SHA: `UNRECORDED`.
- [ ] Every linked commit receipt completed; actual commit SHAs: `UNRECORDED`.
- [ ] Combined verification commands/evidence and remaining gaps: `UNRECORDED`.
- [ ] Reviewer and consumer handoff acceptance: `UNRECORDED`.
- [ ] Actual merged branch/PR reference: `UNRECORDED`.
