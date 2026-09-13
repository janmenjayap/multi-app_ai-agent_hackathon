# Branch: `feat/agent-runtime`

**Owner:** P3. **Purpose:** Give the three backend roles one structured-call wrapper with explicit budgets, immutable first outputs, and recorded failures.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [F02](../commits/F02.md), [B01](../commits/B01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [A01 — Share a bounded, recorded structured-call wrapper](../commits/A01.md)
   - Suggested subject: `feat(agents): add bounded structured calls and immutable proposal records [A01]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/adapter-core`](feat-adapter-core.md)
- [`feat/github-adapter`](feat-github-adapter.md)
- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)
- [`feat/workflow-driver`](feat-workflow-driver.md)
- [`feat/selection-policy`](feat-selection-policy.md)

Only prerequisite-ready peers overlap. This branch requires B01; provider branches do not need to wait for model integration. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [A01](../commits/A01.md), then join before conformance tests.

## LLM integration handoff

Implement [A01's exact call site](../commits/A01.md#exact-llm-call-site-and-spawning-contract)
and the [agent/LLM specification](../07-agent-spawning-and-llm-integration.md).
`runtime.ts` owns `invokeRole` and bounded retry/resume; `model.ts` owns
`createModelClient`/`dispatchStructured` and the only product `ChatOpenAI` request.
R01 composition injects this into A02–A04; F01 owns packages/server configuration,
F02 the shared signatures, and B01 durable claims/raw results. Mock/live model
mode stays separate from the [provider adapter mode](../08-mcp-api-and-external-app-integration.md).

Prove raw persistence precedes SDK/application parsing, every actual request has
one model-attempt identity, and a committed invocation survives resume without
another request. No model-callable MCP/app tools, dynamic spawn loop, or provider
mutation client belongs here. Hand roles the wrapper and R01 the client factory;
record actual structured-output compatibility separately from fixture evidence.

The branch also owns planned `tools/smoke/model.ts`. Its
[A01 smoke specification](../commits/A01.md#owned-model-compatibility-smoke)
selects one F02 role schema, passes synthetic noncustomer input through the real
A01 wrapper, and stores a private B01 compatibility receipt. F01 registers the
proposed `npm run smoke:model` command; this branch cannot edit packages. Default
stub tests make no live calls, and an explicit live invocation requires configured
model access. The runner imports no app adapters or downstream role implementations.

## Reliability merge handoff

[A01](../commits/A01.md) supplies the model producer required by the [reliability plan](../06-agent-reliability-implementation.md): stage/span and modelAttemptId start/result/error/retry records under canonical runtimeAttemptId, UTC/monotonic timing, prompt/model/schema versions and immutable raw first-output/source digests. providerAttemptId is tool-only; legacy attemptId maps through explicit compatibility with conflicting values rejected.

Persist malformed/refused outputs before corrections and keep task/evaluation identities stable across retries. Test interrupted calls, persistence failures and a bad first output followed by success. Q03 consumes telemetry; Q05 consumes actual original outputs and independent reviewer records. Neither synthetic labels nor model-created judgments can become authenticated human reviews.

## Owned paths and shared-file exclusions

- `src/server/agents/runtime.ts`
- `src/server/agents/model.ts`
- `tools/smoke/model.ts`
- `tests/app/agent-runtime.test.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [A02](../commits/A02.md), [A03](../commits/A03.md), [A04](../commits/A04.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] A01 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
