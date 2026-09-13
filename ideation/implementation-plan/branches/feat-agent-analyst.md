# Branch: `feat/agent-analyst`

**Owner:** P3. **Purpose:** Turn the bounded GitHub evidence projection into cited facts, contradictions, candidate changes, and explicit unknowns.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [A01](../commits/A01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [A02 — Add the Incident Evidence Analyst](../commits/A02.md)
   - Suggested subject: `feat(agents): add cited incident evidence analyst [A02]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/agent-drafter`](feat-agent-drafter.md)
- [`feat/agent-auditor`](feat-agent-auditor.md)
- [`feat/github-adapter`](feat-github-adapter.md)
- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)

A03/A04 have the same A01 merge gate, not a dependency on this branch. Runtime R01 still invokes analyst before drafter and auditor. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [A02](../commits/A02.md), then join before conformance tests.

## LLM and app integration handoff

Implement [A02's invocation boundary](../commits/A02.md#exact-analyst-invocation-and-external-evidence-boundary)
and the [agent/LLM specification](../07-agent-spawning-and-llm-integration.md).
`analyst/index.ts` exports `analyzeIncident(AnalystInput, ctx, deps)`; R01's
`analyze_incident` node calls it after complete source reads and valid nonempty
selection. It calls A01 `invokeRole` once logically per revision and returns
`IncidentAssessment` plus immutable output references. R01 then supplies A03 the
validated artifact. Source reads belong to I02/R01 through the
[external-app adapters](../08-mcp-api-and-external-app-integration.md), not to a
GitHub/MCP tool attached to the analyst. Keep env/model-client creation in A01
and startup configuration in F01. Test the exact scoped request and error handoff.

## Reliability merge handoff

[A02](../commits/A02.md) preserves first analyst output, factual-clause/source references, input/output digests and correction history for the [reliability plan](../06-agent-reliability-implementation.md). Mechanical citation membership is separate from semantic entailment.

Use independently labeled fixtures for causal overclaiming, contradictions, stale evidence and injection. Hand Q05 reviewable uncorrected actual outputs when available; valid citations, auditor agreement and fixture passes do not establish real grounding/completeness. Missing human reviews remain unverified.

## Owned paths and shared-file exclusions

- `src/server/agents/analyst/index.ts`
- `src/server/agents/analyst/prompt.ts`
- `src/server/agents/analyst/validate.ts`
- `tests/app/analyst.test.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [R01](../commits/R01.md), [Q05](../commits/Q05.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] A02 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
