# Branch: `feat/adapter-core`

**Owner:** P2. **Purpose:** Give all four provider adapters one bounded, observable transport contract and an explicit way to distinguish complete reads, definitive failures, and unknown writes.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [F02](../commits/F02.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [I01 — Share bounded transport, normalization, and smoke-test plumbing](../commits/I01.md)
   - Suggested subject: `feat(adapters): add bounded transport and smoke harness [I01]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/durable-core`](feat-durable-core.md)
- [`feat/selection-policy`](feat-selection-policy.md)
- [`feat/operator-console`](feat-operator-console.md)
- [`feat/evaluation-fixtures`](feat-evaluation-fixtures.md)

These peers can develop against F02 while this branch owns only the common adapter files; each peer still observes its own hard gates. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [I01](../commits/I01.md), then join before conformance tests.

## API/MCP integration handoff

[I01's implementation mapping](../commits/I01.md#external-app-integration-to-implement-in-this-commit)
and the [external-app guide](../08-mcp-api-and-external-app-integration.md) define
the concrete seam: bounded REST transport in the owned common files; F01 validates
`PG_ADAPTER_MODE=fake|rest`; F02 freezes result/capability contracts; R01 constructs
clients in `src/server/composition.ts`. Inject separate read and mutation
capabilities and emit provider attempts without giving app tools to model roles.
This branch makes no LLM calls. MCP lifecycle, schema discovery and per-method
mapping are an optional reviewed follow-up; unsupported `mcp` mode cannot silently
activate or fall back after an uncertain write. Include credential-missing,
capability-isolation and pagination/unknown-write evidence in the handoff.

## Reliability merge handoff

[I01](../commits/I01.md) provides the attempt/receipt producer seam in the [reliability plan](../06-agent-reliability-implementation.md): canonical runtimeAttemptId, logicalCallId and tool-only providerAttemptId, scoped request/response digests, UTC/monotonic windows, pagination coverage, provider errors and retry schedules. modelAttemptId belongs to models; legacy attemptId maps explicitly with conflicting values rejected. Runtime integration injects durable sinks; this module opens no parallel monitor store.

Separate read-only capabilities allow B07 and Q02 to retrieve provider state independently. Trust is assigned at the verified producer/ingestion boundary, never by a caller-selected evidence mode. Require explicit incomplete reads, distinct HTTP/provider outcomes and no automatic uncertain mutation retries before I02–I05 consume the seam.

## Owned paths and shared-file exclusions

- `src/server/adapters/common/transport.ts`
- `src/server/adapters/common/pagination.ts`
- `src/server/adapters/common/errors.ts`
- `tools/smoke/providers.ts`
- `tests/adapters/common.test.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [I02](../commits/I02.md), [I03](../commits/I03.md), [I04](../commits/I04.md), [I05](../commits/I05.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] I01 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
