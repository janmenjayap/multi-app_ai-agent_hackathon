# PromiseGuard agent reliability: definition and implementation audit

Audit date: September 14, 2026 (IST). Scope: the current working tree, including uncommitted implementation, against all 69 files under `implementation-plan/` and the four requested proposal, architecture, scenario, and requirements documents. Historical committed plan at `ba374912aec1f986ca3c89ba603ebeed60586005` was also cross-checked. No application code was changed by this audit.

**Verdict: partially implemented.** The offline checker and monitoring/measurement engine work. The reliable multi-app agent, independent provider evidence collection, and actual agent evaluation remain unimplemented or unobserved. The hackathon reliability requirement is still open.

**Model-provider decision, September 14:** the implementation now targets the
Gemini Developer API free tier with stable `gemini-3.8-flash`, direct
`models.generateContent`, and server-only `GEMINI_API_KEY`. This changes no
historical evidence count: live compatibility is still unrun. Free-tier model
runs are restricted to synthetic data, and safety/quota blocks remain failed or
unrun evidence rather than triggering a paid or mock fallback.

## What the original plan means

Reliability means demonstrating that the agent makes grounded decisions, performs only authorized actions, and reaches the independently verified expected state—or stops with the correct explicit outcome when it cannot.

It has three complementary parts:

1. **Agent decision quality:** judge original analyst/drafter outputs against frozen source facts and independent human labels for grounding, completeness, decision quality, and honest handoff. A valid citation ID, model confidence, auditor agreement, or human approval does not establish truth. Preserve the first result even when a later correction succeeds. See [canonical agent/system distinction](demo-scenarios-and-reliability.md#5-agent-reliability-and-system-reliability-are-different) and [M7](demo-scenarios-and-reliability.md#m7--first-proposal-agent-quality).
2. **Execution/process correctness:** trace actual model/tool attempts, approval and source checks, exact request binding, retries, unknown writes, reconciliation, verification order, and completion claims. These observations explain how the run behaved. Runtime code must also enforce the controls; detecting a violation afterward does not prevent it. See [trace rules](promiseguard-architecture.md#engine-a-deterministic-runtime-and-trace-rules).
3. **Outcome correctness:** freeze expected predicates before execution; collect scoped initial state S0 and fresh final state S1 independently from the apps; compare fields, IDs, associations, counts, protected records, and operation history. The agent's final response or a successful API response is not the oracle. See [connected-app verification](demo-scenarios-and-reliability.md#8-verify-the-connected-apps-not-the-final-response).

**Therefore the answer is both trace monitoring and expected-versus-actual state comparison, plus independent semantic evaluation of the AI's output.** A clean trace cannot prove a write happened or a claim is true. Final-state equality alone can hide an unauthorized intermediate write. The plan explicitly requires the evidence to be combined, including missing-evidence and failure states.

This definition predates the monitor addition: committed HEAD already distinguishes agent/system quality, limits trace claims, and requires frozen expectations plus independent before/after reads. The newer architecture makes those requirements explicit as [engines A, B, and C](promiseguard-architecture.md#16-measurement-engines-and-integration-with-the-existing-checker).

For the golden path, expected success means one correct HubSpot task, one note, one exact Gmail draft, one GitHub impact comment, and one Slack thread with verified links; unrelated Beta records remain unchanged, no duplicates or forbidden sends occur, and approval and grounded content requirements pass. An ambiguous contact should instead produce a correct safe block with no protected effects. Reliability does not require forcing every input into `completed`.

## What exists in code

- **Expected/observed comparison — implemented for supplied evidence.** [check-evidence.mjs](../tools/reliability/check-evidence.mjs) compares required fields, effect counts, protected before/after records, forbidden operations, and readback history. [assess.ts](../src/server/monitoring/assess.ts) uses the frozen manifest rather than allowing imported evidence to shrink expectations, requires four app snapshots, joins trace/outcome results, and checks cross-record links. Main anchors: checker lines 93–160; assessor lines 245–307.
- **Trace checks — implemented for declared events.** The assessor checks ordering, approval/hash/freshness declarations, forbidden calls, read-after-write, unresolved writes, bounded time/call budgets, and premature success. Main anchors: assessor lines 43–177 and 181–222. No application event producer or real approval authentication exists.
- **Measurement durability — implemented locally.** [monitor-store.ts](../src/server/storage/monitor-store.ts) freezes manifests, stores events/evidence revisions/labels, and supports leased jobs and reassessment. [worker.ts](../src/server/monitoring/worker.ts) runs bounded measurement ticks and preserves pending/exhausted attempts. This is monitor storage, not the planned business-effect ledger or an atomic application-state/event/job transaction.
- **M1–M7 calculation — implemented for supplied observations.** [metrics.ts](../src/server/evaluations/metrics.ts) computes task success, tool success, predicate/acknowledgement verification, recovery, duplicates, latency, and first-proposal quality. It keeps raw counts, attempt IDs, versions, and modes separate, uses null for empty denominators, and deduplicates repeated measurements.
- **Semantic label scoring — implemented; actual review absent.** Assessor lines 224–242 distinguish first-proposal quality from the proposal frozen into the execution plan. The system consumes labels; it does not read source text and independently establish their truth. Original text storage, reviewer reasons/corrections, real model outputs, and actual human reviews remain missing integration work.
- **Local trace/report CLI — implemented.** The CLI imports and reads observations; it does not retrieve provider state or execute an agent. The current event schema also lacks the planned stage/span hierarchy, detailed model-attempt diagnostics, retry/backoff events, and separate transport/provider outcomes. LangSmith export, application scheduling, operator UI, and the full scenario harness are absent.

The [monitor guide](../tools/monitoring/README.md) states these boundaries accurately. The implementation-plan README likewise treats F01/F02 and Q02–Q05 as unfinished packages despite reusable monitor components.

## Fresh verification and material limits

Using the existing Node **24.21.0** runtime:

- `npm test` rebuilt the TypeScript and passed **129/129 tests**: 95 monitor tests and 34 checker tests, zero failures or skips. The first restricted run encountered subprocess `EPERM`; the approved rerun passed. Log: `/tmp/promiseguard-reliability-audit-tests-approved.tap`.
- The original synthetic checker input passed **115/115 assertions**, exit 0. These are assertions on one fixture, not independent agent scenarios. Result: `/tmp/promiseguard-reliability-audit-checker.json`.
- A fresh SQLite demo processed one measurement job with no failed or exhausted jobs and one passing synthetic assessment. Result: `/tmp/promiseguard-reliability-audit-demo.json`.
- `sha256sum -c tools/monitoring/validation.sha256` passed for every listed input, matching the existing verification receipt.
- Focused assessor checks: wrong observed Gmail recipient and missing observed draft produce failed outcomes; absent evidence and absent human labels produce unverified results. Relabeling a generated fixture as imported evidence still passes, confirming that an evidence-mode string does not authenticate provenance.

The reproducible probe script and results are `/tmp/promiseguard-reliability-audit-probes.mjs` and `/tmp/promiseguard-reliability-audit-probes.json`. Run with `/tmp/node-v24.21.0-linux-x64/bin/node /tmp/promiseguard-reliability-audit-probes.mjs`. These temporary files are audit receipts, not committed product tests.

Two limitations matter particularly for the hackathon scorecard:

1. **False-completion coverage is narrower than the full planned claim.** In assessor lines 43–47, `falseCompletion` counts success before recorded verification or while writes are unresolved. If recorded verification says success but the supplied final snapshot contains a wrong recipient or missing draft, the overall assessment correctly fails, yet this counter can remain zero. Metrics lines 145–148 disclose its narrower meaning. Before claiming zero false completion, add an explicit completed-versus-independent-outcome contradiction result with clear evidence timing and counting rules; retain the current premature-claim counter separately.
2. **A report cannot enumerate unrun scenarios.** Metrics lines 181–190 explicitly limit coverage to supplied registered attempts. Q04/Q05 still need the frozen suite census so failed and not-run cases are visible. A single green demo group does not establish 18-family coverage. Unsupported-claim counts are also proposal-level proxies, not individual factual-clause counts.

The synthetic generator copies expected fields into observed records and creates every tool event, approval assertion, proposal reference, and positive `reviewerKind: human` label ([demo.ts](../src/server/monitoring/demo.ts), lines 4–67). This is appropriate for testing monitor behavior, but none of those labels are actual human judgments.

**Observed product evidence remains: zero application attempts, zero model calls, zero live provider workflows, and zero actual human semantic reviews**, as recorded in the [existing receipt](../tools/monitoring/verification.md#boundaries-and-reproduction) and consistent with the inspected source tree. No external apps or models were called by this audit.

## Required completion path

Keep reliability as a P0 deliverable with behavioral evidence, not a dashboard milestone. Reuse the tested monitor.

1. **Build the executable controlled workflow:** F01/F02, adapters, model stages, selection/plan policy, authentic Slack approval, business-effect ledger, guarded writes, and runtime readback. B07 must obtain fresh provider records and gate completion on all required artifacts, including the final Slack readback.
2. **Complete Q01/Q02 collection:** freeze harness-owned expectations and versions; independently collect paginated S0/S1 provider reads, Gmail MIME, actual linked records, operation history, and provenance. Store observed values from provider responses, never copies of plan values.
3. **Complete Q03 integration:** persist each application transition, canonical event, and measurement job in the same application transaction; schedule assessment for waiting, blocked, failed, partial, completed, and stalled runs. A later separate monitor append does not satisfy this atomicity requirement.
4. **Complete Q04/Q05 evaluation:** run the real graph against frozen fake-provider scenarios and real test accounts; retain original model outputs and human labels; show M1–M7 with raw denominators, versions, failures, unverified results, and unrun cases. Address the false-completion reporting gap before presenting that release claim.
5. **Close demonstrated release gates and deliver R02:** preserve real S1 and S2 evidence, safety/approval/tampering cases, a reviewable result surface, and the short reliability brief/demo. The complete plan targets 18 families and 42 baseline/repetition attempts plus declared variants/repair legs, with at least five live scenarios. A narrower first demo must disclose the uncompleted full-suite gate.

Optional LangSmith export (Q06), richer UI, and production scaling can follow core evidence. LangSmith is diagnostic infrastructure, not the pass/fail authority. The [global register](implementation-plan/Global%20Scale.md#5-release-gates-and-metric-integrity) correctly leaves G1–G6 open; a first working demo can close G1–G4/G6 while openly retaining incomplete G5.

At audit time, much of the monitor implementation (`src/`, package files, and monitor tests/tools) was untracked. The current working tree contains the tested code; the HEAD commit alone does not reproduce it. Preserve that baseline through the existing P00 plan before claiming a reproducible release.

**Accurate current claim:** “We implemented and tested an offline reliability checker and monitor. Integrated agent reliability and live multi-app outcomes are not yet demonstrated.”

## Planning follow-up

The [detailed reliability implementation plan](implementation-plan/06-agent-reliability-implementation.md)
now assigns these gaps to the existing commit briefs, including real telemetry,
provider collection, original-output review, scenario census, and versioned
completion-claim measurement. It is a plan update; the observed baseline above
and its historical receipts are unchanged.

### September 14 follow-up: missing LLM and external-app execution seams

The [agent spawning and LLM integration guide](implementation-plan/07-agent-spawning-and-llm-integration.md)
and [MCP/API/external-app integration guide](implementation-plan/08-mcp-api-and-external-app-integration.md)
now assign explicit locations and handoffs for the two remaining execution
dependencies. This is planned remediation; the audit counts and verification
receipts above are historical observations, not results rerun by this update.

- **Agent execution gap:** there is no application scheduler/graph dispatching
  three actual model roles. F01 owns compatible model/framework dependencies
  and server-only configuration; F02 owns the typed role/result/event seams;
  A01 adds `src/server/agents/runtime.ts` and `model.ts`; A02–A04 add the separate
  analyst, drafter and auditor entry points. B04's driver schedules R01's graph;
  R01's `src/server/composition.ts` injects the model wrapper, budgets and durable
  artifact/event sinks. Acceptance needs actual structured-output compatibility
  receipts, preserved first responses, failure-budget tests and scoped contexts.
  “Spawn” denotes bounded backend role calls, not a new OS process or tool loop.
- **External-app gap:** I01–I05 must implement the real typed transports and
  adapters, and prove their configured credentials against disposable accounts.
  R01's source-read nodes call GitHub/HubSpot adapters and B02 applies pure
  validation/selection; B05 owns Slack review/approval and fresh source
  guards; B06 owns ordered HubSpot task/note, Gmail draft and GitHub comment
  effects; B07 owns fresh readback and Slack finalization. Q02 separately reads
  provider state with provenance and completeness, rather than copying mutation
  responses or B07 verdicts. REST is required for the MVP; MCP remains disabled
  without an approved tested tool map. Qualify reads first; later protected-write
  mappings require explicit adapter conformance and all existing runtime guards.
  Assistant-plugin access
  does not establish application authentication.
- **Combined proof gap:** R01 must join the real role calls and app capabilities
  into the same workflow, and R02 must preserve a reproducible release manifest
  and observed proof. A successful model smoke plus unrelated provider smokes
  does not prove a live multi-agent run. F02/Q04/Q05 keep fake/model-live/provider-
  live provenance separate without reinterpreting legacy synthetic receipts.

These acceptance details do not close the existing reliability gate. All three
dimensions—original model quality, enforced execution trace and independently
observed app outcomes—remain required before claiming integrated completion.
