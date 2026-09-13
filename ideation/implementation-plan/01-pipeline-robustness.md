# Pipeline robustness review and build gates

**Review baseline: September 13, 2026.** The pipeline can be made substantially
more robust by implementing and testing the boundaries already specified. There
is no running product pipeline to benchmark or optimize yet. Repository inspection
found planning documents, the offline checker, its synthetic fixture, and checker
tests; no frontend, backend, adapters, agents, database, or live evidence collector.
This review changes the implementation plan, not executable behavior.

The [proposal](../final-project-promiseguard.md) owns product scope;
the [architecture](../promiseguard-architecture.md) owns the intended runtime;
the [demo and reliability plan](../demo-scenarios-and-reliability.md) owns scenarios,
M1–M7 metrics, and acceptance. The [workflow schematic](02-agent-workflow.md)
explains the component boundaries this review relies on.

## 1. Keep the strong parts of the design

These are **designed but unimplemented**, not existing runtime protections:

- Four business apps only: GitHub, HubSpot, Slack, Gmail. Gmail produces a draft;
  sending is absent from the runtime adapter surface.
- Three bounded model roles propose evidence assessments and language. Code
  selects customers, grants authority, executes effects, and verifies results.
- Exact service, commitment, company, owner, and designated-contact identities.
  Incomplete reads and ambiguity stop execution instead of becoming empty results.
- Immutable plans and Slack approvals bound to the exact payload, source state,
  revision, authorized human, workspace/channel/thread, and expiry.
- Durable incident identity, stable effect keys, one writer, provider reconciliation,
  and independent read-back. Graph checkpoints alone are insufficient.
- Preserved partial work and explicit failure. A clean model audit, successful HTTP
  response, or green trace cannot establish useful completion.

Adding more agents, apps, queues, or dashboards does not close these gaps. Build
the required controls and their evidence first.

## 2. What the existing code proves

[check-evidence.mjs](../../tools/reliability/check-evidence.mjs) checks supplied
four-app snapshots and an ordered effect ledger. Its
[tests](../../tests/reliability/check-evidence.test.mjs) exercise declared field
matching, protected records, duplicates, forbidden operations, read-after-write
ordering, and the difference between reuse and a changed record. Its
[README](../../tools/reliability/README.md) documents the exact limits.

The existing code does **not** validate live approval, select eligible customers,
collect provider state, run an agent, prevent a write, or recover an uncertain
write. Particular gaps must be covered around it:

1. A `completed` contract requiring only Slack can pass. A frozen S1 manifest must
   independently require the HubSpot task and note, Gmail draft, GitHub comment,
   and Slack thread. Never derive required artifacts from whichever writes worked.
2. A multi-address `to` string can pass when the expected string matches. Runtime
   policy and MIME normalization must enforce exactly one designated mailbox and
   preserve every observed To/Cc/Bcc address for verification.
3. Final-state fields can pass after an incorrect intermediate update. Every
   attempted payload must be bound to its approval before dispatch, with separate
   trace assertions for intermediate payloads and completion-message ordering.
4. Version 1 cannot represent unresolved writes. Reconcile first or export
   incomplete evidence; never relabel a timeout as known nonapplication.
5. Supplied completeness, provenance, actors, and links are trusted. Independently
   collect complete scoped provider reads and validate actual associations/links.

Keep checker v1 stable while implementing the manifest validator, collector,
runtime rules, and exporter around it. A later schema change needs a distinct
version and compatibility tests, not silently changed meaning.

## 3. Prioritized implementation gates

P0 gates below are prerequisites for claiming the four-app product works. Several
can be implemented on separate branches, but their dependencies must merge before
live execution is enabled. Suggested control IDs are stable acceptance references.

### R1 — P0: freeze contracts before parallel implementation

**Implementation commits:** F01–F02; Q01 supplies shared fixtures.

**Already designed:** typed graph state, source snapshots, agent artifacts,
immutable plans, effect ledger, public statuses, and scenario manifests.

**Refinement:** freeze shared schemas and representative fixtures first. Include
schema/policy/prompt versions; distinguish business run, invocation attempt,
evaluation attempt, plan revision, effect key, and provider attempt. Reject
unsupported artifact versions at handoffs. Define canonical JSON/body bytes and
plan-hash test vectors so UI, approval, execution, and verification agree.

**Pass gate:** all branch owners can consume the same S1 fixture. Altering a
recipient, body, owner, selected set, or policy changes the plan hash; changing
JSON object-key order does not. Plan revisions preserve the same logical effect
keys. The public status enum does not acquire a misleading generic `success`.

**Parallel work after this gate:** adapters, individual agents, UI fixtures,
storage, selection policy, and evaluation harness. Contract changes require one
coordinated schema PR and dependent branch updates.

### R2 — P0: complete, bounded source collection and exact selection

**Implementation commits:** I01–I05, B02, Q01, Q04.

**Already designed:** typed incident validation; complete paginated CRM reads;
exact service/status/date/owner/contact policy; source freshness.

**Refinement:** make completeness and termination reason explicit in every list
result. Freeze total operation/page/time budgets and a clock interface. Preserve
potentially affected malformed records as blocking evidence. Use the canonical
fixture's 72-hour horizon, 10-minute approval TTL, and 30-second freshness setting
as versioned test settings, not undocumented production defaults.

**Pass gate:** canonical families 2, 3, 13, and 14 distinguish valid empty results,
ambiguous identities, unsupported incidents, and failed second pages. Only a
complete valid empty eligible set produces `completed_no_affected_commitments`.
Run four-app read/write/read-back conformance smoke tests with actual disposable
accounts before claiming the adapter implementation is live-verified.

**Do not:** use fuzzy email/company matching, silently drop invalid candidates,
fetch arbitrary submitted URLs, or interpret provider HTTP success without its
provider-level success/error semantics.

### R3 — P0: bind every protected dispatch to current authority

**Implementation commits:** B03, B05–B06, I04–I05, Q03–Q04.

**Already designed:** exact plan review and read-back, strict Slack approval,
fresh-state guard, permanent rejection of a revision, draft-only execution.

**Refinement:** centralize this guard in the sole protected dispatch path. Persist
the request hash and trusted approval reference with each mutation intent. Typed
executor methods accept approved effect references, not arbitrary caller payloads.
Future destination IDs may fill only the deterministic substitutions included in
the approved plan; model rewriting after approval is forbidden.

Post/reconcile the Slack review in a separate graph node from the pure approval
interrupt. Resume can restart the interrupt node, so it must contain no provider
write. The resumed record reference only wakes the workflow; trusted Slack reads
and the deterministic guard still decide authorization on the same run/thread.
This replay behavior is documented by [LangGraph's interrupt guide](https://docs.langchain.com/oss/javascript/langgraph/interrupts);
the installed package compatibility still needs verification in F01/B04.

**Pass gate:** families 6, 7, 12, and 15 reject stale/expired, unauthorized, wrong
thread/hash, bot-authored, edited/deleted, or replayed approvals. Recheck decision
and expiry before each remaining write, refreshing sources after the freshness
limit. Approval/source read failure cannot grant authority. Source text containing
instructions cannot change recipient, policy, or tools. Assert no protected write
before valid approval and no send method in the adapter interface.

**Limit:** fresh reads bound staleness; independent providers do not supply an
atomic transaction between the last check and the subsequent write.

### R4 — P0: durable effects and safe stopping; P1: automatic S4 recovery

**Implementation commits:** B01, B04, B06–B08, Q04. B08 is optional automatic
recovery; safe reconciliation-or-stop in B06 is mandatory.

**Already designed:** a single backend process, one invocation/writer per incident,
atomic local effect claim, stable remote marker, and reconciliation on replay.

**Refinement:** persist intent before dispatch and explicitly separate known
failure from unknown outcome. A timeout never releases a claim for blind retry.
After startup, reconcile pending effects before scheduling new writes. Keep graph
checkpoint storage separate from the authoritative application ledger.

**P0 pass gate:** S2/family 5 and family 16 preserve IDs and creation counts;
families 10 and 18 preserve applied artifacts and return `failed_partial` after
later failure or incompatible drift. An ambiguous write with unresolved outcome
also produces `failed_partial`, even without a returned provider ID. Persistence
failure stops protected dispatches. Never delete successful work to fake a reset.

**P1 recovery gate:** family 9/S4 kills the process after Gmail accepts a create
but before the local result is saved. Resume finds exactly one equivalent draft,
adopts and verifies it, and continues within the frozen recovery deadline. Zero
matches after bounded settling reads remain uncertain; multiple/conflicting
matches require operator review. No automatic recreation of human-edited or
missing drafts. If P1 is unfinished, report safe partial stopping without claiming
durable accepted-write recovery.

**Deployment constraint:** use one process with local serialization. A database
unique key alone does not fence a second process from making the same remote call.
SQLite permits one writer at a time per database file; the one-process executor
is our additional application constraint for the MVP, not a guarantee supplied by
SQLite. See [SQLite's deployment guidance](https://www.sqlite.org/whentouse.html).

### R5 — P0: verify meaning, artifacts, and completion separately

**Implementation commits:** A01–A04, B07, Q02–Q05.

**Already designed:** schema/reference checks, blind semantic audit, independent
provider verifier, final Slack read-back, original-proposal evaluation.

**Refinement:** save the unedited first model output before retries/correction.
Freeze independently authored expectations before running the worker. Validate
task owner/associations, note/comment links, and parsed draft bytes using separate
provider reads. Canonicalize only documented transport transformations; do not
normalize away a recipient or wording difference.

**Pass gate:** families 4, 11, and 17 catch unsupported certainty, incorrect
recipient/body/draft status, missing outputs, invalid citations, and unavailable
required agents. An existing citation alone is not evidence that a claim follows
from it. Human labels record first-proposal defects and false blocks separately
from eventual completion. All required artifact checks precede their success
claims; full completion follows the final Slack read-back.

### R6 — P0: bounded retries and measurable failures

**Implementation commits:** I01, A01, B01, B04, Q03, Q05; Q06 adds optional
LangSmith export after local evidence is trustworthy.

**Already designed:** one retry owner per operation; bounded budgets; durable local
events, measurement jobs, and a read-only reliability monitor.

**Refinement:** choose explicit defaults when dependencies are pinned and record
them in the release manifest. Disable nested SDK/graph retries for mutations.
Include attempt latency, retry waiting, human waiting, unknown outcomes, and
timeouts in the appropriate raw observations. Reserve a bounded share of runtime
resources for the monitor so optional telemetry cannot starve execution.
Commit each application transition, its canonical event, and measurement job in
one application-database transaction; do not claim atomicity with the separate
graph checkpoint database or any remote provider.

**Pass gate:** family 8 recovers a transient read within budget; definitive
permission denial and model exhaustion stop. Resume/job replay does not create a
new evaluation denominator. Missing measurements show `pending`/`incomplete`, not
passed. LangSmith outage retains local evidence and queues export; local ledger
failure stops writes. A product run may be verified while its aggregate evaluation
is still pending, and the UI must display that distinction.

### R7 — P0: freeze release evidence before claiming completion

**Implementation commits:** Q04–Q05, R01–R02. Control IDs R1–R7 in this review
are acceptance references; zero-padded R01–R02 are release commits in the build plan.

Run the existing checker suite separately from simulated and live scenarios.
Use the canonical 18 families and their listed variants; the proposed 42
baseline/repetition attempts do not cover every variant. Record actual counts,
not target counts. Preserve original failures and separately labeled repair legs.

**Pass gate:** real S1/S2 and S3 safety evidence, approval/freshness safety cases,
complete snapshots, semantic labels, scenario/commit versions, and measured timing
support each demonstrated claim. The product remains incomplete if it has only
synthetic checker evidence. Do not combine modes into one reliability percentage.

## 4. Parallelism that improves throughput without weakening control

- **Safe during implementation:** build four adapters independently; implement the
  three agents against frozen fixtures; build UI and evaluation harness from shared
  contracts; implement storage and policy in parallel with assigned file ownership.
- **Optional at runtime:** after validated incident identity/service, independent
  GitHub evidence and HubSpot reads can overlap within shared budgets. Use an
  explicit join; if either input is incomplete, no downstream plan proceeds. This
  is a later optimization of the architecture's initially sequential graph.
- **Sequential at runtime:** fixed eligible set → analyst → drafter → validator →
  auditor → frozen plan → Slack approval → fresh guard → ordered effects/read-backs
  → Slack summary/read-back. Keep the protected effect loop serial for the MVP.
- **Asynchronous:** status polling, sanitized trace export, and local evaluation
  jobs can progress independently. None authorizes protected work or changes the
  verified run status on the basis of a model or telemetry-service response.

Do not spend the core delivery window on multi-process execution, a distributed
queue, extra agents/apps, vector retrieval, tenant OAuth, or autonomous repairs.
The plan deliberately optimizes teamwork first; latency optimization follows a
measured, correctly verified golden path.
