# Branch: `feat/gmail-adapter`

**Owner:** P2. **Purpose:** Create and find approval-bound customer drafts, preserving every recipient/header/body field needed for independent verification.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [I01](../commits/I01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [I05 — Implement Gmail drafts and complete MIME readback](../commits/I05.md)
   - Suggested subject: `feat(gmail): add draft-only adapter and complete MIME readback [I05]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/github-adapter`](feat-github-adapter.md)
- [`feat/hubspot-adapter`](feat-hubspot-adapter.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)
- [`feat/agent-drafter`](feat-agent-drafter.md)

Provider siblings share I01 only. The drafter can independently develop text fixtures after A01; neither branch gains permission to send or bypass B06. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [I05](../commits/I05.md), then join before conformance tests.

## API/MCP integration handoff

Use the [MCP/API and external-app guide](../08-mcp-api-and-external-app-integration.md)
for exact methods, account setup and transport activation gates.

[I05's OAuth/route/MIME mapping](../commits/I05.md#external-app-integration-to-implement-in-this-commit)
implements draft POST/list/full GET and exact-marker lookup in the owned Gmail
files. F01 owns server OAuth/mailbox configuration; R01 injects draft creation
into B06 and separate readers into B07/Q02. Writer `gmail.compose` can send at
Google, so the application enforces draft-only methods/egress. Q02's optional
`gmail.readonly` credential supports scoped message/history evidence; unavailable
history remains unverified. Models produce text earlier via A01 and receive no
Gmail client or token. Optional MCP must preserve complete MIME/readback rather
than return email summaries. Handoff requires disposable OAuth/create/find/full
read proof and explicit unrun gates; the worker and smoke never send mail.

## Reliability merge handoff

[I05](../commits/I05.md) supplies full MIME, all actual recipient headers, content/draft state, stable IDs and complete marker-list/read receipts for the [reliability plan](../06-agent-reliability-implementation.md). Unexpected headers and changed content must survive normalization.

The worker stays draft-only. Q02 receives separately scoped read/history evidence where permitted; unsupported history coverage remains unverified, since absence of a send method alone does not prove no send occurred. Test duplicate/folded headers, wrong state, later-page duplicates and acknowledged-but-missing drafts; actual live proof needs independent full draft retrieval.

## Owned paths and shared-file exclusions

- `src/server/adapters/gmail.ts`
- `src/server/adapters/gmail-mime.ts`
- `tests/adapters/gmail.test.ts`
- `tools/smoke/gmail.ts`

P1 remains the sole owner of package/lock files, shared schemas, migrations, and
graph/API composition. Do not edit those files or another provider/agent branch's
files here. After I01 merges, its common transport has one owner too. Request a
small upstream follow-up instead of privately changing an imported contract.

## Merge and handoff

Merge only after the prerequisites, owned tests, typecheck/build, and independent
review pass. Include the intended commit ID, resulting SHA, exact evidence mode,
commands/exit codes, and any unrun live/model smoke result. A successful fixture
suite is not proof of live account or model access.

Hand off to [B06](../commits/B06.md), [B07](../commits/B07.md), [Q02](../commits/Q02.md), [R01](../commits/R01.md); P1 updates the global completion register after
review. This branch supplies a bounded module and does not authorize live product
writes. R01 must still integrate approval, freshness, effect-ledger execution,
and independent verification in their canonical order.

- [ ] Prerequisite SHAs and integration base recorded: ______
- [ ] I05 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
