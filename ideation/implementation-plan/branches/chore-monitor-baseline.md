# Branch plan — `chore/monitor-baseline`

**Owner:** P1; independent evidence review by P4.
**Status:** proposed branch; local monitor implementation already exists.
**Branch point:** current integration `main`, after inventorying the dirty tree.
**Hard merge prerequisites:** none; coordinate existing user-owned doc relocations.

## Commit order

1. [P00 — Preserve the reviewed monitoring baseline](../commits/P00.md).
   Suggested subject: `chore(P00): preserve the verified local reliability monitor`.

## Work that can overlap

Account-access inspection, independent fixture expectations, source/claim review,
and a review of the existing monitor can run alongside P1's baseline review.
Feature implementation starts from the merged baseline through F01/F02; do not
branch from a `main` that lacks the uncommitted monitor and assume it is present.

## Agent and external-app integration handoff

Preserve the monitor and planning baseline; no model or provider connection belongs here.

[P00](../commits/P00.md) defines the exact steps and checks. Read
[guide 07: LLM calls](../07-agent-spawning-and-llm-integration.md) and
[guide 08: MCP/API and apps](../08-mcp-api-and-external-app-integration.md).
Preserve this branch's existing merge gates and allowed paths; these obligations
refine planned work and do not establish live integration.

## File ownership and exclusions

P1 owns the selected baseline source, configuration, and integration commit.
P4 reviews tests and evidence. Preserve user edits and the `ideation/exploration/`
relocations; account for their link dependencies explicitly. No provider action,
application feature, or deployment belongs in this branch.

## Reliability implementation and proof

Preserve the existing `monitor-v1`/`checker-v1` source hashes, receipt and synthetic scope before adding new versions. Explicitly carry forward that v1 `falseCompletion` measures premature success only, imported modes do not authenticate origin, generated human labels are fixtures, and the 129 tests are monitor/checker tests. Downstream F02/Q03/Q05 own the versioned correction; P00 does not silently change old report meaning.

See the [detailed reliability completion plan](../06-agent-reliability-implementation.md) and the linked commit brief for exact steps, file ownership and acceptance. These additions describe future implementation; no live gate is closed by this documentation update.

## Merge and handoff

Merge one reviewed baseline into `main`, then hand its real SHA to
[`feat/foundation`](feat-foundation.md). Existing passing tests prove the local
monitor only. Follow the [branch execution rules](README.md) and record completion
in [Global Scale](../Global%20Scale.md); this plan itself creates no branch.

- [ ] P00 review and exact-source checks recorded.
- [ ] Merged baseline SHA: **pending**.
- [ ] Downstream owner notified of the new shared base.
