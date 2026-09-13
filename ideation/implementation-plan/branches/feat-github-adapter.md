# Branch: `feat/github-adapter`

**Owner:** P2. **Purpose:** Provide bounded GitHub evidence reads and narrow methods for one approved, marked engineering-impact comment.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [I01](../commits/I01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [I02 — Implement GitHub incident evidence and one marked impact comment](../commits/I02.md)
   - Suggested subject: `feat(github): add incident evidence and marked impact comments [I02]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)
- [`feat/agent-analyst`](feat-agent-analyst.md)
- [`feat/agent-drafter`](feat-agent-drafter.md)
- [`feat/agent-auditor`](feat-agent-auditor.md)

Provider siblings share only the already merged I01 interface; agent peers may overlap after A01 independently passes its own gates. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [I02](../commits/I02.md), then join before conformance tests.

## API/MCP integration handoff

Use the [MCP/API and external-app guide](../08-mcp-api-and-external-app-integration.md)
for exact methods, account setup and transport activation gates.

[I02's route/access mapping](../commits/I02.md#external-app-integration-to-implement-in-this-commit)
implements source reads and marked comment GET/POST/PATCH through I01 in
`src/server/adapters/github.ts`. F01 validates repository/token configuration;
R01's source node reads GitHub before B02 policy, B06 submits approved comment
bytes, and B07/Q02 independently read back actual records. Verify the repo-scoped
Issues grant plus any selected read-only technical-reference permissions.
No model role gets this adapter or makes API calls directly. Any optional MCP
method mapping must preserve the same contract and complete readback. Handoff
requires fixture conformance and a separately labeled disposable source/comment
create/get/update/find smoke result, including all unrun access gates.

## Reliability merge handoff

[I02](../commits/I02.md) hands B02/B06/B07/Q02 actual immutable issue/comment IDs, source versions, content/link observations and complete enumeration receipts under the [reliability plan](../06-agent-reliability-implementation.md). Creation acknowledgements and fresh readback remain separate.

Tests include a correct-looking comment on the wrong issue, a later-page duplicate, changed linked IDs and denied readback after successful creation. Never infer a unique match from one page or replace observed content with approved content. Live smoke claims require actual scoped receipt IDs; fixture conformance remains a separate result.

## Owned paths and shared-file exclusions

- `src/server/adapters/github.ts`
- `tests/adapters/github.test.ts`
- `tools/smoke/github.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [B02](../commits/B02.md), [B06](../commits/B06.md), [B07](../commits/B07.md), [Q02](../commits/Q02.md), [R01](../commits/R01.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] I02 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
