# Branch: `feat/agent-drafter`

**Owner:** P3. **Purpose:** Generate grounded customer text from a fixed input scope while leaving recipient, owner, dates, and action authority in deterministic code.

**Execution update:** A03 is implemented and merged; see the completion record below.
The following text preserves the original planning baseline.

This was a proposed branch plan. It created no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [A01](../commits/A01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [A03 — Add the Customer Update Drafter](../commits/A03.md)
   - Suggested subject: `feat(agents): add grounded customer update drafter [A03]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/agent-analyst`](feat-agent-analyst.md)
- [`feat/agent-auditor`](feat-agent-auditor.md)
- [`feat/plan-policy`](feat-plan-policy.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)
- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)

A02/A04 can merge independently after A01; B03 and provider peers observe their own prerequisites. Runtime drafting waits for the analyst artifact, not merely branch availability. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [A03](../commits/A03.md), then join before conformance tests.

## LLM and app integration handoff

Implement [A03's invocation boundary](../commits/A03.md#exact-drafter-invocation-and-gmail-boundary)
and the [agent/LLM specification](../07-agent-spawning-and-llm-integration.md).
`drafter/index.ts` exports `draftCustomerUpdate(DrafterInput, ctx, deps)`; R01's
`draft_customer_update` node calls it after validated analysis and fixed selection.
Use A01 `invokeRole` with fresh drafter context and return exact `DraftProposal`
text/source/output references. B03 guards and freezes content; R01 prepares a
separate auditor context. One logical invocation returns exactly one draft entry
per selected commitment; the initial fixture has one. Validate full selected-set
coverage and block excess capacity without dropping records or spawning a model
per customer. Gmail creation belongs to
B06/I05 after approval through the [app integration path](../08-mcp-api-and-external-app-integration.md).
This role never receives app credentials, MCP tools, or Gmail send capability.
Test fixed scope and unchanged original text through repair/resume.

## Reliability merge handoff

[A03](../commits/A03.md) preserves exact first-draft bytes, selected scope, claim/source references and correction revisions under the [reliability plan](../06-agent-reliability-implementation.md). B03 freezes the approved revision while Q05 evaluates the first draft.

Test invented ETA with a valid citation, unsupported certainty, omitted uncertainty and changed customer identity, including a later corrected success. Actual human labels must bind the original source/output digests and reviewer reasons; approval or successful Gmail creation cannot erase a first-proposal quality failure.

## Owned paths and shared-file exclusions

- `src/server/agents/drafter/index.ts`
- `src/server/agents/drafter/prompt.ts`
- `src/server/agents/drafter/validate.ts`
- `tests/app/drafter.test.ts`

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

- [x] Prerequisite and base SHAs recorded in the [A03 receipt](../commits/A03.md#completion-receipt).
- [x] A03 implemented at `afa83ab7053f6baad8ad960ff626304c3aa57492`;
  main merge `6af6d75f81a4482bf817da05e686639a8dfe6c20`.
- [x] 17 focused synthetic tests, typecheck and server/web build pass; live
  model/provider and human semantic evidence remain unrun.
- [x] Independent Codex `a03_review` accepted R01/Q05 module handoffs; integrating
  owner recorded the receipt and C06 status. Runtime integration remains R01.
