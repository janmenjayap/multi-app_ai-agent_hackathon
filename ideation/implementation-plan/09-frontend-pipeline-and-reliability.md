# Frontend pipeline and reliability implementation

This guide is the canonical frontend execution plan for PromiseGuard. It turns
the product surface described in the [architecture](../promiseguard-architecture.md),
the truth and evidence rules in the [demo contract](../demo-scenarios-and-reliability.md),
and the existing U01-U03 briefs into one implementable browser plan.

It does not add an implementation ID, branch, runtime authority, or release
claim. [U01](commits/U01.md) builds the fixture-backed screen,
[U02](commits/U02.md) connects required durable product and reliability data, and
[U03](commits/U03.md) optionally adds deeper cohort inspection. F01, F02, B04,
Q01, Q05, and R02 retain their existing ownership and merge gates.

## 0. Reviewed repository baseline

The September 14, 2026 working-tree review found no unstaged or untracked
frontend, HTTP API, application-contract, browser-test, or related configuration
implementation to merge into this plan. The dirty paths at review time were
implementation-plan Markdown from this planning update. The tracked application
baseline remains the Node/TypeScript reliability checker and standalone monitor:
`src/web/`, application API routes, React/Vite dependencies, and browser tests do
not exist. Generated `dist/` and installed `node_modules/` are not implementation
inputs and do not close any frontend gate.

Therefore frontend delivery starts at F01 rather than on an assumed partial UI:

```text
P00 monitor baseline
  -> F01 browser/server toolchain
  -> F02 versioned browser DTOs and states
  -> Q01 canonical scenarios ---- parallel alignment ---- U01 browser fixtures
  -> B01/B04 durable API --------> U02 live transport
  -> R01 real workflow ----------> U02 integration proof
  -> Q04/Q05 saved report -------> U02 release summary / optional U03
  -> R02 clean-browser demo and evidence freeze
```

If implementation files appear after this dated review, inventory them by path,
owner, contract version, test status, and intended commit ID before assigning
work. Never overwrite or silently relabel an uncommitted teammate implementation.

## 1. Release decision and completion boundary

The frontend is one operator console, not a chat application or a general
analytics dashboard. It must let an operator answer, in order:

1. What incident and customer promise are in scope?
2. What did deterministic policy select or exclude, and why?
3. What did each model role propose, and what evidence supports it?
4. What exact plan is awaiting or received Slack approval?
5. Which protected effects were attempted, reused, verified, or left uncertain?
6. Is the product run complete, and is its reliability assessment independently
   complete? These are separate questions.

The P0 release includes U01 and U02. It must expose a compact measured summary
with saved raw numerators/denominators and links to authorized evidence. U03 is
P1: it adds detailed M1-M7, attempt, claim, and evidence drilldowns but cannot be
required to understand whether the current run is verified or unverified.

The browser is never an approval, model, provider, evidence-provenance, or metric
authority. It sends bounded commands to the backend and renders server facts.

## 2. One-screen information architecture

Use a desktop-first work surface that remains usable on a narrow viewport. Keep
the current incident and run identity visible while the operator scans the
pipeline. The required reading order is:

```text
+--------------------------------------------------------------------------+
| PromiseGuard | environment/mode | run ID | connection | operator menu    |
+--------------------------------------------------------------------------+
| Incident URL [........................................] [Start or reopen] |
| Product status | assessment status | last verified | Slack review link    |
+--------------------------------------------------------------------------+
| Pipeline: ingest - select - analyze - draft - audit - approve             |
|           - execute - verify - assess                                     |
+-----------------------------------+--------------------------------------+
| Evidence and promises             | Exact plan and approval              |
| incident facts and citations      | recipient, subject, body, effects    |
| selected/excluded commitments     | revision/hash and Slack status       |
+-----------------------------------+--------------------------------------+
| Verified results and app links                                           |
| HubSpot task/note | Gmail draft | GitHub comment | Slack summary          |
+--------------------------------------------------------------------------+
| Reliability summary: process | outcome | first proposal | census/gaps     |
+--------------------------------------------------------------------------+
```

Do not place every region in a decorative card. Use full-width status and
pipeline bands, a two-column review workspace, and an unframed results section.
Individual repeated effects, claims, or attempts may use compact rows. Technical
details open in an inline disclosure or side panel and must not hide the current
status or change browser history unexpectedly.

### Persistent header

- Product name, current environment, model mode, provider mode, and synthetic or
  collected evidence indicator.
- Durable `runId`, with a copy control only when a run exists.
- Connection state: live, reconnecting, offline, or session expired. Connection
  state is not product state.
- No provider token, model key, raw credential reference, or private artifact
  content appears in the DOM, source map, fixture, or browser log.

### Start or reopen

- Accept one allowlisted GitHub issue URL. Keep the last submitted value visible.
- Disable duplicate submit while the command is unresolved, but do not disable
  reopening an existing durable run after the response is known.
- Render stable server error code, useful message, retryability, and correlation
  ID. Never expose a raw provider exception.
- `Start or reopen` creates no promise that agent work has started. Show the
  persisted run ID and current server status returned by B04.

### Primary status band

Always render these independently:

- `productStatus`: the canonical run state: pending, running, awaiting approval,
  executing, safely blocked, failed, failed partial, completed, or completed with
  no affected commitments. Waiting is a stage state, not a run-state alias.
- `traceAssessment`: process evidence pending, pass, fail, incomplete, or N/A.
- `outcomeAssessment`: expected-versus-observed result pending, pass, fail,
  incomplete, or N/A.
- `firstProposalAssessment`: original agent quality pending, pass, fail,
  unreviewed, or N/A.

An overall green treatment is allowed only when the server supplies verified
product completion and every release-required assessment is passing. A completed
product with pending, missing, or failed assessment stays visibly unverified.

## 3. Pipeline and agent visualization

Render one stable ordered pipeline. Rows or nodes do not move as statuses change:

1. `ingest`: ingest incident and complete source retrieval.
2. `select`: select affected commitments with deterministic policy.
3. `analyze`: run the Evidence Analyst model role.
4. `draft`: run the Customer Update Drafter model role.
5. `audit`: run the Blind Semantic Auditor model role.
6. `approve`: freeze the plan and wait for Slack approval.
7. `execute`: apply guarded HubSpot, Gmail, and GitHub effects.
8. `verify`: verify each provider artifact and final Slack summary.
9. `assess`: collect and assess independent reliability evidence.

Each visible stage consumes a server-provided stable stage ID and shows:

- status: `pending`, `running`, `waiting`, `completed`, `blocked`, `failed`, or
  `skipped`;
- first start and latest update time;
- attempt count and latest attempt reference when authorized;
- short outcome or waiting reason;
- evidence mode and source where relevant;
- child model/tool attempts in a disclosure, never hidden counts.

The stage status is execution progress, not truth. A completed `draft` stage means
a validly shaped draft was produced; it does not mean its claims passed human
review. A completed provider call does not mean the artifact passed readback.

Show the three model roles by name and preserve their order. Do not visualize
deterministic policy, Slack approval, execution, verification, or assessment as
additional AI agents. Retry attempts remain children of one logical role call;
browser polling or backend resumption must not create new visible model work.

### Attempt details

For model attempts show role, logical call, model attempt, outcome, model/prompt/
schema versions, bounded timing, and original output reference when authorized.
For provider attempts show app, operation, provider attempt, transport outcome,
provider outcome, reconciliation state, and readback reference. Unknown values
render as unavailable, never as zero, success, or an empty string.

## 4. Evidence, plan, effects, and reliability presentation

### Evidence and promises

- Show normalized incident fields and cited source facts with retrieval time.
- Show selected and excluded commitments in separate lists with policy reason.
- Keep incomplete retrieval, missing identity, ambiguity, and no affected
  commitments visually distinct.
- Put one supporting source field beside each demo-critical model claim. A
  citation ID links to a fact; it does not itself assert that the claim is true.

### Exact plan and approval

- Render plan revision, hash prefix, selected commitment, exact designated
  recipient, subject, decoded body, and ordered effects.
- Make recipient and draft content readable without opening raw JSON.
- Link to the Slack review thread and render server-observed status, approver,
  decision time, expiry, and invalidation reason when authorized.
- Do not add Approve or Reject buttons. Reconcile only asks the backend to inspect
  eligible durable work; it cannot grant approval or alter a payload.

### Effects and readback

For every planned effect show app, operation, durable effect key, state, provider
ID/link when known, created-versus-reused result, latest readback time, and field
comparison verdict. Keep task and note as separate HubSpot effects. Show Gmail as
draft-only and never imply delivery.

Unknown mutation outcome, conflicting artifact, missing readback, field mismatch,
and later provider drift require different labels. A failed partial run keeps all
earlier accepted effects visible; it must not collapse into a generic error page.

### Compact P0 reliability summary

U02 renders server-saved values without arithmetic in the browser:

- process/trace result and evidence coverage;
- independently observed outcome result and required-field mismatches;
- original first-proposal result and human-label coverage;
- duplicate, forbidden-effect, approval-bypass, false-completion, and recovery
  critical counts when present;
- M1-M7 raw numerator/denominator or N/A when supplied by Q05;
- mode, evaluator version, manifest version, report cutoff/watermark, cohort ID,
  planned/attempted/assessed/unverified/unrun census counts, and report link.

Zero denominator renders `N/A (0 eligible)`. Zero human labels renders
`Unverified (0 reviewed)`. Missing Q05 data renders `Report unavailable`; U01
fixtures must never appear as a live fallback.

### Optional U03 inspection

U03 adds drilldowns from a saved metric or critical count to exact suite entries,
attempts, claims, labels, field comparisons, and evidence references. It keeps:

- first unedited proposal separate from corrected or selected plan;
- premature success separate from outcome-contradicted completion;
- claim-time contradiction separate from later drift;
- failed/setup-failed/unrun census entries visible;
- v1 and v2 evaluator meanings, evidence modes, and cohorts unblended.

## 5. Minimum browser DTO contract

F02 owns the final Zod and TypeScript definitions in `src/shared/api.ts`. The
names may be adjusted once during F02 review, but the following semantics and
absence states are mandatory so U01, B04, Q05, and U02 do not invent competing
projections.

```ts
type AssessmentState =
  | "pending"
  | "pass"
  | "fail"
  | "incomplete"
  | "unverified"
  | "not_applicable";
type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "executing"
  | "safely_blocked"
  | "failed"
  | "failed_partial"
  | "completed"
  | "completed_no_affected_commitments";
type StageStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";
type EffectStatus =
  | "planned"
  | "intent_persisted"
  | "dispatching"
  | "unknown"
  | "applied"
  | "verified"
  | "failed";
type ReportAvailability = "pending" | "available" | "unavailable";

interface RunView {
  schemaVersion: string;
  revision: number;
  runId: string;
  incident: IncidentView;
  configuration: ConfigurationView;
  productStatus: RunStatus;
  statusReason?: string;
  stages: StageView[];
  commitments: CommitmentSelectionView;
  plan?: PlanView;
  approval?: ApprovalView;
  effects: EffectView[];
  assessments: {
    trace: AssessmentSummaryView;
    outcome: AssessmentSummaryView;
    firstProposal: AssessmentSummaryView;
  };
  report?: EvaluationSummaryView;
  reportAvailability: ReportAvailability;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
}

interface RunEventsPage {
  schemaVersion: string;
  runId: string;
  runRevision: number;
  events: RunEventView[];
  nextCursor: string;
  hasMore: boolean;
}

interface EvaluationSummaryView {
  reportId: string;
  cohortId: string;
  evaluatorVersion: string;
  manifestVersion: string;
  evidenceMode: string;
  cutoffAt: string;
  watermark: string;
  census: CensusCountsView;
  metrics: MetricCountView[];
  criticalCounts: CriticalCountView[];
  gaps: EvidenceGapView[];
}
```

All response variants include a schema version. Commands return a server-assigned
identity and never accept terminal status, approval, provider observation, label,
or provenance fields from the browser. Read endpoints return redacted references
the current operator is authorized to open.

## 6. API, polling, and browser lifecycle

Use the same-origin routes frozen in
[shared contracts](05-contracts-and-handoffs.md#6-http-and-ui-boundary):

- `POST /api/runs` to create or reopen a durable run;
- `GET /api/runs/:id` for the latest redacted projection;
- `GET /api/runs/:id/events?after=<cursor>` for ordered incremental events;
- `POST /api/runs/:id/reconcile` for guarded inspection/resumption;
- versioned trace, assessment, evaluation, and cohort metric reads for details.

While active, poll approximately every two seconds. Allow only one status request
and one event request in flight. Apply bounded backoff with jitter after retryable
failure. Deduplicate by event ID, reject a projection older than the rendered run
revision, and persist only the run ID plus opaque cursor needed to reopen. Never
persist credentials, approval state, raw evidence, or a client-authored product
status in local storage.

Closing, refreshing, sleeping, or reconnecting the browser must not cancel,
restart, duplicate, or extend backend work. On session expiry, stop commands and
polling, retain already redacted content, and request authentication. After login,
reload the authoritative run projection before resuming event consumption.

## 7. Complete state and error matrix

U01 fixtures and U02 integration tests cover all of these distinct views:

- no run selected;
- command validation failure;
- accepted and pending;
- active model or provider stage;
- persisted waiting for Slack approval;
- safely blocked before protected effects;
- failed before any protected effect;
- failed partial with accepted, unknown, and unattempted effects;
- completed product with assessment pending;
- completed product with contradicted outcome;
- completed and independently verified;
- completed with no affected commitments and complete absence evidence;
- report pending or unavailable;
- no human labels;
- zero eligible metric denominator;
- polling offline with stale last-known projection;
- reconnecting with duplicate or out-of-order events;
- stale projection/report revision;
- unauthorized run or evidence reference, represented by the HTTP error contract
  rather than a report-availability value;
- expired operator session;
- backend ready but monitor temporarily unavailable.

Use explicit text plus icon and color for every status. Never rely on color alone,
turn an `unknown` effect into `failed`, or turn a transport error into a product
or stage failure.

## 8. Responsive and accessibility requirements

- At 1280 pixels and wider, use the two-column evidence/plan workspace. Between
  768 and 1279 pixels, preserve the pipeline and stack dense sections in reading
  order. Below 768 pixels, use a single column and a horizontally scrollable or
  vertically stepped pipeline with visible stage names; do not shrink text by
  viewport width.
- Keep input, pipeline nodes, status chips, effect rows, and metric rows at stable
  dimensions so loading text and long IDs do not shift the layout. Truncate only
  IDs and URLs with an accessible full-value disclosure; wrap human-readable text.
- All commands and disclosures are keyboard reachable with visible focus.
- Use semantic headings, form labels, lists/tables for structured facts, and
  `aria-live="polite"` only for concise status changes. Do not announce every poll.
- Move focus to a command error after submit and to the run heading after a
  successful create/reopen. Opening and closing technical detail restores focus.
- Pending, failed, blocked, mismatched, and unverified states meet WCAG AA contrast
  and include text labels. Motion respects reduced-motion settings.
- At 375x812, 768x1024, and 1440x900, no status, command, pipeline label, plan
  content, or evidence row overlaps or escapes its container.

## 9. Test and screenshot plan

### U01 component and fixture checks

- Render all state-matrix fixtures with an explicit `Synthetic` marker.
- Assert exact recipient/subject/body, selected/excluded commitments, and stable
  pipeline order.
- Assert completed-but-unverified, failed original proposal with corrected plan,
  wrong expected/observed recipient, missing S1, no labels, 0/0, and failed partial.
- Assert there is no approval command and no browser metric calculation.
- Run automated accessibility checks plus keyboard traversal for commands and
  disclosures. Capture 375x812, 768x1024, and 1440x900 screenshots.

### U02 browser/API contract checks

- Create/reopen one run, consume multiple event pages, refresh, reconnect, and
  retain one `runId`, evaluation attempt, runtime identities, and model-call count.
- Exercise duplicate submit, overlapping-poll prevention, backoff, out-of-order
  events, stale run/report revisions, session expiry, authorization failure,
  monitor outage, and backend continuation after browser closure.
- Compare rendered summary values byte-for-byte with the saved Q05 projection.
- Run one fake-adapter S1 path, S2 replay, and S3 safe block through the assembled
  HTTP API. These remain simulated until the corresponding live release evidence.

### Release browser checks

- Rehearse the real S1 path from incident input through Slack navigation, app
  links/readbacks, and verified summary.
- Reopen S2 and show unchanged provider IDs/counts without a new model invocation.
- Show one prevented unsafe action and its zero protected effects.
- Verify redaction, clean-session authentication, all authorized links, readable
  recording zoom, notification suppression, and the two-minute runbook sequence.

Do not use screenshots as product or reliability proof. Each screenshot references
the exact fixture or saved run/report and its evidence mode.

## 10. Commit-by-commit delivery

### F01 - scaffold

- Add and pin React, Vite, the chosen component test environment, and accessible
  test utilities through the foundation owner.
- Add frontend build/test scripts, static entry point, and Fastify static-asset
  production smoke without adding product-success behavior.

### F02 - contracts

- Freeze `RunView`, event-page, command/error, assessment-summary, evaluation-
  summary, and redacted-reference schemas with accepted/rejected examples.
- Freeze stable product, stage, effect, assessment, availability, and evidence
  states. Review with B04, Q05, U01/U02, and R02 owners before merge.

### Q01 - fixture worlds

- Publish canonical scenario/world snapshots and stateful fake outputs for S1,
  S2, S3 and named faults, linked to frozen scenario and evidence identities.
  U01 owns browser-only state fixtures and may merge after F02 without waiting
  for Q01; it adopts Q01 identities when available without changing UI semantics.
  Synthetic fixtures cannot use live presentation defaults without the marker.

### U01 - fixture-backed operator console

- Build the complete one-screen hierarchy, stable pipeline, evidence/plan/effect
  presentation, compact reliability placeholders, responsive behavior, and
  accessibility states against F02 examples and U01-owned browser fixtures.
- Land component, accessibility, viewport, and screenshot checks with the screen.

### B04 - durable API projection

- Implement the exact F02 read/command contracts, revisions, cursors, stable
  errors, authorization, and CSRF. Projection tests are co-reviewed by P4.
- Keep optional report data honest so U02 can merge before Q05.

### U02 - live required console

- Replace fixture transport with authenticated API reads/commands, polling,
  reconnect, deduplication, stale-revision protection, and durable reopen.
- Render the P0 reliability summary from server-saved values and preserve all
  unavailable/unverified states. Add browser/API integration checks.

### Q05 - measured report projection

- Publish authorized, versioned saved summary and detail references with raw
  counts, census, gaps, modes, versions, cutoff, and watermark.
- Supply hand-calculated examples for U02/U03 tests. Do not make frontend code an
  aggregation implementation.

### U03 - optional deep inspection

- Add metric-to-attempt, claim, evidence, label, and field-comparison drilldowns
  only after the saved report contract is stable.
- Keep U02 fully usable when this branch is disabled.

### R02 - release and demo

- Verify the clean-session console against the frozen release and actual saved
  report, then record the exact screenshots/runbook references and deferred UI.
- Treat U02 as a hard release gate and U03 as a gate only when its capability is
  claimed.

## 11. Parallel work review and conflict controls

After F02 freezes contracts, these tasks can proceed in parallel:

- P4 owns `App.tsx`, root layout/status semantics, the API client contract, and
  final joins. One person edits each of these files at a time.
- A frontend helper builds evidence and exact-plan presentation against U01
  fixtures. Another builds the stable pipeline and effect rows. A test owner
  builds state-matrix, accessibility, and viewport cases.
- P1 implements B04 endpoint/projection behavior while P4 uses a controllable HTTP
  fixture. They join through F02 examples, not private object shapes.
- Q01 fixture work and U01 can overlap after F02 freezes shapes and synthetic
  marking rules. U01 owns browser fixtures; Q01 owns scenario truth, so neither
  edits the other's files. Q05 report plumbing can overlap U02 preparation; U02
  may merge with an explicit unavailable report, while release verification waits
  for exact saved-value comparisons after Q05.
- P2 supplies normalized app names, operation labels, links, and readback fixtures;
  P3 supplies role/stage names and original-output states. Neither edits browser
  root files or changes display contracts outside F02 review.

Required sequential joins:

1. F01 toolchain before F02 contract merge.
2. F02 DTO/state review before U01 component integration.
3. U01 root layout before U02 replaces fixture transport.
4. B04 live contract before U02 merge.
5. Q05 saved report before release verification and before U03 merge.
6. U02 plus Q05 actual evidence before R02 records the product UI.

File conflict controls:

- P1 alone changes root dependencies, Vite/test configuration, shared schemas,
  Fastify static registration, API mounts, and release composition.
- P4 alone performs final edits to `App.tsx`, `EvaluationSummary.tsx`, and the
  joined screen styles during each UI commit.
- Component helpers use disjoint files and hand changes to P4 before integration.
- U03 does not reformat or redesign U01/U02 while adding drilldowns.
- Live provider tests, fixture resets, and recording use one serialized sandbox;
  component tests and isolated HTTP fixtures may run concurrently.

If P4 is also executing Q02-Q05, delegate a disjoint U01 component or tests, then
stop UI expansion at U02. Do not trade independent evidence collection or human
labels for optional U03 polish.

## 12. Definition of frontend done

The required frontend is done only when all statements below have reviewed
evidence:

- U01 and U02 implementation, tests, build, and three viewport checks pass.
- A clean browser can start/reopen one durable run and reconnect without duplicate
  model work, attempts, effects, or deadline changes.
- The screen shows all three model roles and all deterministic control stages
  without calling non-agent work an agent.
- Exact plan, Slack authority, protected effects, readbacks, and provider links
  are reviewable without raw JSON.
- Product, process, outcome, and first-proposal assessments cannot collapse into
  one optimistic status.
- Pending, blocked, partial, unverified, no-label, 0/0, unavailable-report,
  stale, offline, unauthorized, and expired-session states are tested.
- The compact reliability summary matches a saved Q05 report and performs no
  browser aggregation.
- No secret, private raw artifact, browser approval authority, provider/model
  client, or fabricated fixture result reaches the production browser bundle.
- The real S1/S2 and safety demo remains readable in the required recording
  view, with all modes and shortened waiting clearly labeled.
- R02 records whether optional U03 is included or deferred and claims only the
  UI behavior supported by the frozen release.

Until those checks pass, this document and its linked commit briefs describe
planned implementation rather than a working frontend or demonstrated reliability.