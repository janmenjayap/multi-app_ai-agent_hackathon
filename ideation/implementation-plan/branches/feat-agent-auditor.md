# Branch: `feat/agent-auditor`

**Owner:** P3. **Purpose:** Check proposed customer text against original sources and flag unsupported, contradictory, or omitted claims before review progression.

A04 is implemented and merged with focused synthetic verification. See the
[completion receipt](../commits/A04.md#completion-receipt) for SHAs, commands,
review and handoff. R01 integration and actual model quality remain unrun.

## Base and exact commit order

Start from the reviewed integration `main` after these hard gates have merged: [A01](../commits/A01.md).
Preserve the team's reviewed shared baseline; no uncommitted work should be lost
when a later developer creates a branch/worktree.

1. [A04 — Add the Blind Semantic Auditor](../commits/A04.md)
   - Subject: `feat(agents): [A04] add independent-context semantic auditor`

This branch contains that one planned implementation commit. Its linked commit
file owns detailed steps, tests, exclusions, and completion evidence. If coding
starts earlier against frozen contracts, keep the PR unmerged until the exact
hard gates above land and rerun its checks against updated `main`.

## Branches that may overlap

- [`feat/agent-analyst`](feat-agent-analyst.md)
- [`feat/agent-drafter`](feat-agent-drafter.md)
- [`feat/readback-verifier`](feat-readback-verifier.md)
- [`feat/slack-adapter`](feat-slack-adapter.md)

A02/A03 use the same A01 gate; verifier/provider peers have independent dependencies. Runtime remains analyst → drafter → checks → auditor before freezing the plan. These are possible concurrent work lanes, not a requirement to
staff all of them at once. Inside this branch, split only the distinct paths and
owners listed in [A04](../commits/A04.md), then join before conformance tests.

## LLM and app integration handoff

Implement [A04's invocation boundary](../commits/A04.md#exact-auditor-invocation-and-authority-boundary)
and the [agent/LLM specification](../07-agent-spawning-and-llm-integration.md).
`auditor/index.ts` exports `auditSemantics(AuditorInput, ctx, deps)`; R01's
`audit_semantics` node invokes it through A01 after drafting and deterministic
checks. A separate original-source/text projection excludes previous-role
rationale/confidence. `AuditVerdict` and raw-output references return to R01 for
clear/concern/required-failure routing. A clear result permits plan freeze only;
Slack approval, app execution and verification remain on the deterministic
[MCP/API boundary](../08-mcp-api-and-external-app-integration.md).
Prove context exclusion and no progression on required-role failure; do not add
app tools, a repair loop, or a self-issued human review label.

## Reliability merge handoff

[A04](../commits/A04.md) records its blind input projection, first findings and errors for the [reliability plan](../06-agent-reliability-implementation.md). It receives original source facts and proposed text without another role's rationale/confidence; a clean verdict does not grant approval or prove truth.

Q05 compares real verdicts with independent human labels to distinguish missed defects and false blocks. Context-leakage, unsupported citation, omitted uncertainty, correct-draft and required-stage failure fixtures gate the module. Preserve the original verdict through later corrections and leave actual usefulness unverified until labeled real outputs exist.

## Owned paths and shared-file exclusions

- `src/server/agents/auditor/index.ts`
- `src/server/agents/auditor/prompt.ts`
- `src/server/agents/auditor/validate.ts`
- `tests/app/auditor.test.ts`

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

- [x] A01 `3923ed30c232a1b722b75c9343859c6487b3ad9a`; tested base `6ca7dab44fefc300e9786d7043fe2d520e3b8d44`.
- [x] A04 `784b32bf96b26ab96188eef6ca9596fe3cdeb6c3`; merge `aabb72317546b21a0b1cba4811b70943a7380896`.
- [x] 10/10 auditor and 25/25 combined auditor/runtime checks, typecheck and builds; live/graph/quality gates unrun.
- [x] Delegated Codex review accepted R01/Q05 module handoff; P1 integrator recorded the receipt.
