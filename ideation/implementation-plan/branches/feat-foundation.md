# Branch plan: feat/foundation

**Owner:** P1. **Status:** F01 and F02 implemented on local `feat/foundation`,
pending commits, receiving-owner acceptance and sequential review/merge.
See the individual receipts for validation; Round 1 is not yet released.
**Canonical source:** [commit backlog](../04-commit-plan.md).
**Base:** integration `main`, after the prerequisite commits below land.

## Purpose and baseline

Extend the preserved monitor baseline into a tested application skeleton, then freeze the interfaces that allow the remaining team to work independently. F01/F02 are partial because the monitor's package and reliability contracts already exist.

## Merge dependencies and exact commit order

External branch-entry gates: [P00](../commits/P00.md).

1. [F01 — Establish the tested application skeleton](../commits/F01.md).
2. [F02 — Freeze shared contracts before concurrent implementation](../commits/F02.md).

F02 depends on F01 within this branch. F01 may land as an independently verified
commit before F02; consumers follow their exact commit gates rather than waiting
for an entire branch label. F02-dependent product branches still require F02.
If interface-compatible work begins before a prerequisite merges, keep it isolated
and rebase onto the dependency-complete main before final validation. Do not merge
unvalidated placeholder behavior.

## Work that can overlap

P2 can check provider access/API requirements while P4 prepares F02 browser DTO
examples and F01 bootstrap/component/browser tests in the commit-owned test files.
Those reviews do not mutate provider business data or root configuration. Product
feature branches may prepare designs, but they must consume F02 before merging
implementations.

## Frontend contract handoff

Follow the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md).
F01 owns the tested React/Vite, component/accessibility, Playwright, static-serving
and no-secret browser toolchain. F02 owns the versioned run/event/command/error,
assessment/report and redacted-reference contracts plus stable state vocabulary,
revision/cursor rules and accepted/rejected examples. U01 and Q01 then proceed as
sibling branches: U01 owns browser display fixtures, Q01 owns scenario truth.

## Reliability merge handoff

Freeze the implementation seams from the [detailed reliability plan](../06-agent-reliability-implementation.md) before consumers merge: canonical spans/attempts, UTC and monotonic/causal timing, immutable source/model artifacts, actual human-label provenance, provider collection receipts, and scoped success claims. Keep existing monitor evidence modes and v1 persisted assessments compatible.

F02 freezes canonical runtimeAttemptId with an explicit conflicting-alias rejection for legacy attemptId, modelAttemptId for models and providerAttemptId for tools. It separates EffectIdRef destination bindings from ApprovedContentRef text bindings: facts/invariants freeze pre-run, exact wording freezes in the approved plan before dispatch, and provider output supplies neither expectation. Keep logical manifest, approved plan/content and resolved-export hashes separate. The no_affected claim type has complete empty-selection/absence evidence and no planRef or final-Slack requirement. B01 owns storage; Q03/Q05 own evaluation/reporting. F01 hands off an injectable bootstrap without silent synthetic fallback.

## Agent and external-app integration handoff

Own model/app configuration, tested dependencies, role invocation/result schemas and narrow adapter contracts before parallel consumers integrate.

[F01](../commits/F01.md), [F02](../commits/F02.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

P1 owns the root package/lock/config and shared contracts. Other owners submit boundary examples and dependency requests; they must not edit these files concurrently. Preserve existing monitor/checker code except the explicitly reviewed compatibility seam in F02.
The linked commit sheets define the complete allowed paths and test ownership.
One person edits each file; independent test work joins the same branch before
the corresponding implementation commit is reviewed.

## Sequential merge handoff

1. Confirm all prerequisite SHAs and finish commits in the order above.
2. Integrate independently authored tests, then run the commit's stated gates on
   the final branch contents. Include failed/unrun checks and evidence mode.
3. Review the complete diff with a teammate; preserve existing unrelated work.
   Merge only after acceptance, then publish the real SHA to consumers.

Publish actual package/schema versions, accepted/rejected payloads, browser test
and build script names, redaction/revision/cursor rules, and both commit SHAs.
B01/B02, I01, A01, Q01, B04, Q05, and U01/U02 then use these contracts. F01
includes the deliberate P00 preservation gate; do not start from the earlier
planning-only HEAD.

## Branch completion receipt

- [ ] Dependency SHAs and actual base SHA: `UNRECORDED`.
- [ ] Every linked commit receipt completed; actual commit SHAs: `UNRECORDED`.
- [ ] Combined verification commands/evidence and remaining gaps: `UNRECORDED`.
- [ ] Reviewer and consumer handoff acceptance: `UNRECORDED`.
- [ ] Actual merged branch/PR reference: `UNRECORDED`.
