# Branch: `feat/hubspot-adapter`

**Owner:** P2. **Purpose:** Expose the complete candidate commitment set and exact ownership/contact associations, plus narrow task/note creation and retrieval.

This is a proposed branch plan. It creates no branch, commit, provider artifact,
or model run. The standalone monitor already exists; the product implementation
owned here remains missing. See the [source backlog](../04-commit-plan.md) and
[shared handoffs](../05-contracts-and-handoffs.md).

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [I01](../commits/I01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [I03 — Implement HubSpot commitments, task, and note](../commits/I03.md)
   - Suggested subject: `feat(hubspot): add commitment reads and owned follow-up artifacts [I03]`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/github-adapter`](feat-github-adapter.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)
- [`feat/gmail-adapter`](feat-gmail-adapter.md)
- [`feat/agent-analyst`](feat-agent-analyst.md)
- [`feat/agent-drafter`](feat-agent-drafter.md)
- [`feat/agent-auditor`](feat-agent-auditor.md)

This branch can overlap provider siblings after I01 and agent peers after their A01 gate; none of those merges is a new prerequisite here. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [I03](../commits/I03.md), then join before conformance tests.

## API/MCP integration handoff

Use the [MCP/API and external-app guide](../08-mcp-api-and-external-app-integration.md)
for exact methods, account setup and transport activation gates.

[I03's route/schema mapping](../commits/I03.md#external-app-integration-to-implement-in-this-commit)
implements complete ticket/company/contact/owner reads and task/note
create/get/find in `src/server/adapters/hubspot.ts`. F01 validates account/token
configuration; R01 supplies the verified property/association mapping and calls
reads before B02 selection. B06 creates approved artifacts and B07/Q02 independently
retrieve actual fields and relationships. Record actual scopes/API family; contact
write authority required by v3 activity creation is broader than task-only.
No LLM invocation or model-callable CRM tool belongs here. Optional MCP preserves
these same fields/permissions. Handoff includes real account mapping plus both
task and note readback, separately from successful fixture tests.

## Reliability merge handoff

[I03](../commits/I03.md) preserves exact commitment/contact/owner/company IDs, task/note fields and all associations needed by the [reliability plan](../06-agent-reliability-implementation.md). Source and final-artifact reads expose complete page coverage and raw-response/version references.

Test wrong immutable owner IDs despite matching names, different task/note associations, later-page duplicates and missing read permissions. Normalization must retain wrong observed values for independent rejection. B02 owns selection; B07/Q02 own comparison. Real task/note smoke evidence must include fresh reads of both artifacts and their associations.

## Owned paths and shared-file exclusions

- `src/server/adapters/hubspot.ts`
- `tests/adapters/hubspot.test.ts`
- `tools/smoke/hubspot.ts`

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
- [ ] I03 implemented and reviewed; merge SHA: ______
- [ ] Evidence and unavailable/failed checks recorded: ______
- [ ] Consumers and P1 accepted the handoff: ______
