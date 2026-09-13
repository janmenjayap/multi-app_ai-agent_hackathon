# Offline outcome-evidence checker

This is a small, dependency-free Node.js checker for the PromiseGuard outcome
contract. It reads **supplied JSON evidence** and checks selected final-state and
event-ledger invariants. It does not call a model, connect to an external app,
execute a workflow, implement approvals/retries, or measure agent reliability.

The checked-in example is explicitly **synthetic**. Passing it establishes that
the checker accepts one internally consistent example, not that PromiseGuard
performed a live four-app workflow.

## Run

Run from the repository root using Node.js 18.19.1 or later:

```bash
node tools/reliability/check-evidence.mjs tools/reliability/examples/happy-path.synthetic.json
node --test tests/reliability/check-evidence.test.mjs
```

No npm install, environment variables, credentials, network, or database are
required. Tests create their own temporary JSON files and remove them afterward;
they do not change provider data or the checked-in example. The CLI subprocess
tests require an environment that permits Node child processes. A restricted
sandbox can return `EPERM`; run the exact test command through the environment's
approved execution path if needed. Do not count a sandbox failure as a pass.

CLI exit codes:

- `0`: all declared offline assertions passed.
- `1`: valid evidence structure, with one or more violated assertions.
- `2`: malformed/incomplete schema, wrong arguments, invalid JSON, unreadable
  file, or file larger than 2 MiB.

Programmatic API:

```javascript
import { checkEvidence } from './tools/reliability/check-evidence.mjs';
const report = checkEvidence(parsedEvidence);
```

The result has `reportVersion`, `scope`, `evidenceKind`, `result`, assertion
counts, fixed failure codes with numeric indices, and a scope limitation. It
never includes raw evidence values, scenario IDs, provider IDs, email addresses,
message text, file paths, or caught exception details. Assertion counts are
**checker assertions**, not independent scenario executions or agent-success
metrics. Several assertions may fail because of the same underlying defect.

## Version 1 evidence format

Use [the complete synthetic example](examples/happy-path.synthetic.json) as the
concrete schema reference. Supply a JSON object with these required fields:

- `schemaVersion`: exactly `1`.
- `evidenceKind`: `synthetic_fixture` or `imported_provider_snapshot`. This is a
  caller-supplied label, not authenticated provenance.
- `scenarioId`: a nonempty local identifier, omitted from reports.
- `observedTerminalStatus`: the state the run actually reported at the evidence
  checkpoint.
- `expected.terminalStatus`: the expected state at that checkpoint. These version
  1 field names also cover nonterminal `awaiting_approval`; passing a checkpoint
  does not establish that the workflow finished.
- `expected.effects`: the complete allowlist of logical effects permitted in
  the evidence window. Each entry contains `app`, nonempty `effectKey`, boolean
  `required`, and nonempty `requiredFields`.
- `expected.protectedRecords`: entries with `app` and stable `id` that must
  exist before and after with identical IDs, effect keys, and fields. Include
  unrelated commitments and read-only source records. At least one effect or
  protected record is required; an empty assertion contract is invalid.
- `snapshots`: exactly one entry for each of `github`, `hubspot`, `slack`, and
  `gmail`, with `complete: true` and arrays `before` and `after`.
- `ledger`: `complete: true` and an ordered `events` array containing every
  mutation attempt, adoption/reuse, and verification read in the same evidence
  window, including failures and attempted forbidden operations. This is an
  effect-evidence ledger, not a general runtime trace: successful worker source
  reads, model calls, and approval events belong in the separate runtime trace.

Allowed checkpoint states are `completed`, `completed_no_affected_commitments`,
`awaiting_approval`, `safely_blocked`, `failed_partial`, and `failed`.
`completed` requires at least one required effect. The three no-consequential-
write states (`completed_no_affected_commitments`, `awaiting_approval`, and
`safely_blocked`) permit only declared Slack coordination effects. For a safe
block without a Slack message, use no effects, unchanged snapshots, and protected
records. For a partial-failure checkpoint, declare already-applied effects as
required and other permitted effects as optional (`required: false`). This
grades a declared checkpoint; it does not recover it.

The checker does not require the five PromiseGuard artifacts or successful work
in all four apps. Four complete snapshot entries can contain unchanged or empty
records. A caller can declare only a Slack effect and receive a passing
`completed` report. Before running the checker, a separate versioned scenario
manifest must require the task, note, Gmail draft, GitHub comment, and Slack
thread for a completed S1 workflow, along with their complete required fields.
Freeze that contract before execution; never remove a missing artifact from the
expectations to make observed evidence pass.

S3/S5 source corrections and partial-run operator repairs contain legitimate
human edits that violate unchanged-source assertions across the whole scenario.
Preserve the full runtime/fault history and use explicitly labeled stage exports
with independently collected post-edit baselines for subsequent checks. The
scenario harness must still assert approval drift and the complete history;
actor-tagging an edit does not exempt it from this checker's rules. Never rewrite
an original baseline or omit an agent mutation to make an export pass.

Each snapshot record has:

```json
{
  "id": "stable-provider-record-id",
  "effectKey": "stable-logical-effect-marker-or-null",
  "fields": {"ownerId": "expected-owner-id"}
}
```

Use actual JSON `null` for source/protected records with no effect marker. IDs
must be unique inside each snapshot array. The app comes from the containing
snapshot. Never include two aliases for the same provider record. The synthetic
example uses readable effect keys; a future app must supply its deterministic
incident/commitment/action key and normalize provider markers to that key.

`requiredFields` compares each declared value exactly, including nested objects
and arrays; object-key order is ignored, array order is significant. Undeclared
fields of an allowed effect are not content-validated. Include all fields that
matter to the plan: owner, commitment and company associations, due dates,
cross-links, and exact draft fields. The generic checker does not know the full
HubSpot business schema and cannot detect an omitted expectation.

It compares declared cross-link values as data; it does not dereference URLs or
check that a linked ID names the intended record in another app. The independent
collector and scenario checks must verify those relationships.

Every Gmail effect must declare `to`, `subject`, a lowercase 64-character
`bodySha256`, `isDraft: true`, `cc: []`, and `bcc: []`. The prototype permits one
designated recipient and no additional Cc/Bcc recipients. The evidence exporter
must normalize actual MIME recipient headers without silently dropping extra
addresses, decode the draft body, and compute the hash using the same byte
normalization as the approved body. This utility compares supplied hashes; it
does not parse MIME, compute a live draft hash, or verify a sent-mail search.

The schema checks only that `to` is a nonempty string: it does not parse addresses
or enforce exactly one mailbox. A comma-separated pair of addresses passes if
the caller supplied the same pair as the expectation. Upstream deterministic
validation must require exactly one approved designated mailbox, then preserve
all actual To/Cc/Bcc addresses when exporting evidence for comparison.

The example's hash represents UTF-8 text with no trailing newline:

> We are investigating the billing-api incident. Root cause is unknown.

Each ordered ledger event contains:

```json
{
  "operation": "create",
  "actor": "executor",
  "app": "gmail",
  "effectKey": "demo:inc42:promise101:draft",
  "outcome": "applied",
  "providerId": "draft-1"
}
```

- `actor`: `executor`, `verifier`, or `human`. A verifier may only read.
- `operation`: `read`, `create`, `update`, `adopt`, `reuse`, `send`, `delete`, or
  `production_mutation`. Use this closed vocabulary; normalize provider-specific
  methods explicitly. Unknown operations are invalid input.
- `outcome`: `applied`, `verified`, `error`, `reused`, or `blocked`.
- Reads allow `verified`, `error`, or `blocked`. `verified` is only valid for a
  verifier read. In this schema it identifies a read whose payload is represented
  in the final snapshot; field assertions still decide whether it is correct.
- Create/update/send/delete/production mutations allow `applied`, `error`, or
  `blocked`. Adopt/reuse allow `reused`, `error`, or `blocked`.
- `effectKey` is required and nonempty for create/update/adopt/reuse; for source
  reads or forbidden operations it may be JSON `null`.
- `providerId` is required for `applied`, `verified`, and `reused` outcomes. It
  can be omitted for errors or blocked attempts.
- Array order is execution order. Readback must follow the latest acknowledged
  create/update/adopt/reuse of that record. Concurrent events require a trustworthy
  per-record causal ordering before export; this utility supplies no clock or
  ordering infrastructure.

Ledger events do not contain validated per-attempt payloads, approval decisions,
or intermediate record snapshots. Extra fields on an event are not checked.
Allowed updates with incorrect intermediate content can therefore pass after
the content is corrected in the final snapshot. A passing ledger also cannot
prove that a Slack completion message was published only after other effects
were verified. Bind every attempted mutation to its approved immutable payload
in the runtime trace and enforce that ordering in the executor; evaluate those
checks separately from this utility.

The bundled example describes a miniature final-state contract, not an execution
protocol: its Slack record contains final links and a `verified` verdict while
its ledger lists the Slack create before the other artifact creates. The checker
does not establish when those Slack fields became visible. Do not use this event
list as a template for publishing completion or as proof of S1's review, approval,
and final-summary transitions.

`error` means there is no unresolved uncertainty about whether the mutation
applied. An API timeout with an unknown write outcome is **not** safely
represented as `error`: reconcile provider state first, or mark the ledger
incomplete and receive exit `2`. Unknown outcomes are intentionally unsupported
in this first version. A future trace exporter can retain richer raw event
categories separately and produce this evidence only after reconciliation.

## What is checked

- Observed status matches the scenario's expected status; claimed completion
  cannot hide required missing or incorrect effects.
- Required effects exist exactly once; present optional effects also match every
  required field and have a verifier read after the last acknowledged action.
- All new/changed records belong to the declared effect allowlist and have
  matching mutation evidence. A change to an existing record requires an applied
  update; reuse/adoption cannot explain changed fields.
- Protected and undeclared records are unchanged, effect markers are stable,
  and no before-record is deleted.
- Every applied write or successful reuse/adoption has a corresponding final
  record and every effect-linked verifier read names a final record.
- Multiple active records with the same app/effect key fail. Multiple applied
  creations also fail, even if a duplicate later disappeared. Repeated legitimate
  updates or adoption/reuse events do not count as duplicate creations.
- Any send, delete, or production-mutation event fails, even if blocked, attributed
  to a human, or subsequently reversed. Run resets must occur outside the evidence
  window. Executor updates are permitted only for GitHub and Slack, reflecting
  the proposed comment/thread update adapters; HubSpot and Gmail effects are
  created or reused.
- A mutation event outside the expectation allowlist fails with
  `undeclared_mutation_event`; this checks a supplied declaration, not approval
  authenticity or permission enforcement.

## Importing real evidence later

There is no provider exporter or integration in this repository yet. To make
`imported_provider_snapshot` meaningful, implement an independent read-only
exporter that captures before/after records from all four test accounts, covers
the entire scoped demo namespace and unrelated protection records, includes all
mutations in its ledger, and derives expected fields from the frozen reviewed
plan. Capture failures and partial writes; do not fill missing evidence with
empty arrays. `complete: true` must mean the relevant scope was fully collected,
not merely that a paginated API returned one page. Retrieve Gmail drafts and
inspect the applicable sent-mail namespace separately; a draft-only query cannot
prove that no send occurred.

Keep credentials, OAuth tokens, authorization headers, raw mail bodies, unrelated
CRM records, and private model reasoning out of these files. Use disposable
synthetic contacts. Locally imported snapshots can still contain necessary
recipient addresses and record IDs; do not commit or publicly upload them without
review. Redacted reports do not sanitize the original files.

The checker trusts supplied evidence, completeness labels, actor labels, event
order, and expectations. It cannot establish that a provider was queried, that
records were fresh, that approval was genuine/unexpired/bound to the exact plan,
that source selection was correct, that claims are supported, or that hidden
effects did not occur. The ledger can expose declared forbidden operation types
even when their effects were reversed, but cannot validate the intermediate
contents of otherwise allowed writes. Independently gathered real snapshots,
actual workflow execution, source/approval guards, deterministic selection tests,
and human semantic review remain required before making product reliability
claims. Unit tests of this checker are not the planned multi-app agent evaluation.
