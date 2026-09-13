# Branch plan: feat/plan-policy

**Owner:** P3. **Status:** proposed branch work; this file creates no branch or commit.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Turn validated selection and role outputs into an exact immutable review plan while keeping effect identities stable across revisions and retries.

## Merge dependencies and exact commit order

External branch-entry gates: [B02](../commits/B02.md).

1. [B03 — Freeze immutable plans, claims, and effect identities](../commits/B03.md).

Role implementations are not additional B03 merge gates: use F02 role contracts and fixtures, then verify the real chain in R01.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

Overlap with feat/workflow-driver, provider branches, role-agent branches, and frontend/evaluation work after their own gates. P4 can prepare independent hash/recipient/body cases in the B03 test file while P3 implements plan code.

## Reliability merge handoff

[B03](../commits/B03.md) freezes exact approved bytes, source/output digests and first-proposal history under the [reliability plan](../06-agent-reliability-implementation.md). Q01 independently freezes semantic facts/invariants pre-run; ApprovedContentRef binds generated wording only to the approved plan before dispatch. Separate EffectIdRef bindings resolve unknown destination IDs through unique independent receipts and only predeclared substitutions. Preserve logical manifest, approved plan/content and concrete-export hashes separately.

Acceptance rejects content resolved from observed provider bytes, wrong plan digests, ambiguous markers, undeclared substitutions and erased first outputs. Q01's semantic oracle remains independent of generated wording. B05/B06/B07 receive the same immutable revision and scope; no_affected bypasses plan creation and its typed claim has no planRef.

## Agent and external-app integration handoff

Validate fixed role outputs and freeze exact app payloads; do not add model or network calls to plan policy.

[B03](../commits/B03.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

Own B03 policy/normalization/effect-key files and its test only. Existing shared canonical/digest helpers are read-only unless P1 merges a reviewed shared change. Do not alter model prompts, adapters, migrations, or root dependency files.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Give B05 and B06 full-hash/revision rules, exact payload/body normalization, allowed future-ID substitutions, stable keys, and preserved first-proposal references. Show that changing content changes approval identity without creating a new logical effect.

## Branch completion receipt

- [ ] Dependency SHAs and actual base SHA: `UNRECORDED`.
- [ ] Every linked commit receipt completed; actual commit SHAs: `UNRECORDED`.
- [ ] Combined verification commands/evidence and remaining gaps: `UNRECORDED`.
- [ ] Reviewer and consumer handoff acceptance: `UNRECORDED`.
- [ ] Actual merged branch/PR reference: `UNRECORDED`.
