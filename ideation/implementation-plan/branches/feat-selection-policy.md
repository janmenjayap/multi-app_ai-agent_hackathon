# Branch plan: feat/selection-policy

**Owner:** P3. **Status:** implemented and merged locally; verified offline.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Implement exact, complete-source customer selection and stable incident identity. Selection is pure deterministic policy; the existing monitor does not implement it.

## Merge dependencies and exact commit order

External branch-entry gates: [F02](../commits/F02.md), [Q01](../commits/Q01.md).

1. [B02 — Select incidents and commitments with deterministic policy](../commits/B02.md).

Q01 must merge before this branch merges; passing against invented local expectations does not replace the independently frozen fixture gate.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with feat/durable-core, adapter branches, agent-role branches, and frontend work after their respective gates. P4 can write this branch's selection test while P3 writes policy source files; coordinate P4's fixture workload explicitly.

## Reliability merge handoff

[B02](../commits/B02.md) must return reproducible policy decisions with source versions, completeness receipts, reference time and reasons, as required by the [reliability plan](../06-agent-reliability-implementation.md). Independent fixtures distinguish complete no-impact, ambiguous-contact safe block and incomplete-source failure; no protected effect follows either blocked or failed selection.

Hand B03 nonempty selected IDs and immutable evidence references. Complete empty selection supplies source/completeness and policy receipts to B04/B07 for typed no_affected claims and absence verification; no planRef or final Slack artifact is required. The parent workflow records the canonical decision event; this pure module gains neither storage nor network authority. Fixture policy success does not establish actual analyst/drafter quality.

## Agent and external-app integration handoff

Consume complete GitHub/HubSpot evidence fetched by R01 nodes; keep policy pure and block model calls for ambiguous or valid-empty selection.

[B02](../commits/B02.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Only B02 policy files and its application test belong here. Do not edit Q01's frozen fixtures/oracle, adapter implementations, shared contracts, package/lockfiles, or migrations; request changes from their owner.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give B03 the exact selected IDs, excluded reasons, source-completeness behavior, and identity-drift decisions, with family 2/13/14 and S3 fixture evidence. R01 later proves real source integration.

## Branch completion receipt

- [x] Base `80450301c0eee2173917c2670e36a006d0c53ab2` contains F02
  `87d3c7d7bad17d54300e452e932c7f226fc74299` and Q01
  `bcced55d61b90b2ce69e077ecc0475b814e27335`.
- [x] B02 implementation: `a7a0fcb4d3b893595d1dc33c8afcf96926bc5cb6`.
- [x] Node 24.21.0: 44 focused selection tests, typecheck, and both builds pass.
  Conventions 1.2, schema 2, `selection-v1`, `promiseguard-demo-v1`.
- [x] Delegated P2/P4 reviews and final `merge_review` accepted the B03/R01 seam.
- [x] Local main merge: `6e82b575ad69530cced50184f1143b31ce734d37`.

The [B02 receipt](../commits/B02.md#completion-receipt) records commands,
evidence and limitations. User-authorized publication targets `main` and
`feat/selection-policy`. No downstream workflow, live-provider, live-model, or
human semantic review claim follows from these synthetic policy tests.
