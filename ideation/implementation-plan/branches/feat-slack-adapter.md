# Branch: `feat/slack-adapter`

**Owner:** P2. **Purpose:** Provide review-thread coordination and faithful observations of human replies so B05 can enforce approval policy.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [I01](../commits/I01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [I04 — Implement Slack review, thread reads, and summary updates](../commits/I04.md)
   - Suggested subject: `feat(slack): add review-thread observations and summary updates [I04]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/github-adapter`](feat-github-adapter.md)
- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)
- [`feat/agent-runtime`](feat-agent-runtime.md)

Prioritize this provider early because B05 depends on it, while sibling adapters remain independent. A01 may overlap once B01/F02 are ready. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [I04](../commits/I04.md), then join before conformance tests.

## API/MCP integration handoff

Use the [MCP/API and external-app guide](../08-mcp-api-and-external-app-integration.md)
for exact methods, account setup and transport activation gates.

[I04's Slack mapping](../commits/I04.md#external-app-integration-to-implement-in-this-commit)
implements `chat.postMessage`, `chat.update`, `conversations.history`, and
`conversations.replies` in `src/server/adapters/slack.ts`. F01 owns posting/reader
tokens and exact team/channel/approver configuration; R01 supplies deterministic
coordination to B05 and separate read capability to B07/Q02. B05 authenticates the
human decision; this transport never grants approval. Verify `chat:write`, channel
membership and appropriate history access through an actual human-reply smoke;
post success alone is insufficient. No model role gets Slack tools, and no webhook
or Events subscription is required by the polling MVP. Optional MCP must meet
the identical authority/version/readback contract before activation.

## Reliability merge handoff

[I04](../commits/I04.md) supplies complete actor/thread/message/edit/deletion observations and separate review/decision/summary receipts for the [reliability plan](../06-agent-reliability-implementation.md). B05 decides authentic approval; B07 binds final-summary claims and reads them back; Q02 independently retrieves history.

Test wrong workspace/thread, bot or forged actor fields, edited/deleted approvals, incomplete replies and HTTP 200 with provider failure. Every coordination mutation remains in attempt history. Posting success grants neither approval nor full completion, and posting access does not prove reply/history-read access.

## Owned paths and shared-file exclusions

- `src/server/adapters/slack.ts`
- `tests/adapters/slack.test.ts`
- `tools/smoke/slack.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [B05](../commits/B05.md), [B07](../commits/B07.md), [Q02](../commits/Q02.md), [R01](../commits/R01.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] I04 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
