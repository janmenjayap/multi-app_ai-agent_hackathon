# PromiseGuard evaluation summary

R02 freezes application source `fa148667016be9f3c778bc76ad9c8ee232f9151d`
under conventions **1.2**. The measured cohort below is inherited Q04 execution
and Q05 reporting evidence, with its original source identities preserved. It
was not rerun on the R02 freeze, which includes the Gemini runtime migration
`25ba4727f0425849a8d10f1fd3b04dd6abcf8c7f`. **No cohort attempt passed: 71 failed and four
remain unverified. Live workflow reliability and human-reviewed model quality
are not demonstrated; G1–G6 remain open.**

This document contains sanitized aggregates. Private sources, original outputs,
provider receipts, reviewer records and SQLite databases remain outside Git.
The [release manifest](release-manifest.json) records the frozen application,
inherited evidence and verification boundaries; the
[reliability brief](reliability-brief.md) explains what each axis establishes.

## Evidence identity and versions

Exactly one application cohort is included:

- Report `report-5bb5b9127b0b2034befe53cd00d0381f146a68e267d84c2375453eee6c52dc85`,
  revision **1**, format `evaluation-report-v2`.
- Cohort `cohort-af82ab805973fea04176bd810db89832e2f843a08fc2ef11e55a1a31eafde087`.
- Provenance `synthetic`; evidence mode `synthetic_fixture`; model `mock`;
  providers `fake`. The actual application graph executed against scripted
  model responses and stateful fake providers. These are application attempts,
  with no live-model or live-provider credit.
- Suite `promiseguard-q01-v1`, fixture `promiseguard-demo-v1`, harness
  `scenario-harness-v1` revision **168**, schema **2**, manifest **2**, evaluator
  `monitor-v2`.
- Frozen fixture versions: app `foundation-f02`, model `scripted-model-v1`,
  prompt `promiseguard-roles-v1`, policy `selection-v1`.
- Execution versions: app `q04-graph-runtime-v1`, model
  `q04-scripted-model-v1`, prompt
  `analyst-prompt-v1_drafter-prompt-v1_auditor-prompt-v1`, policy
  `selection-v1`, schema `schema-v2`.
- Execution source
  `source-sha256:c3bef035b6a54b61b8f7b29eeba5b880b6676e47bd1c7f39a60fa441ba07059c`.
- Report generator Git SHA `5b250645eef9ccf15feaf69d97ce1470776b4dc0`,
  dirty-content SHA-256
  `49abc5f58bdc692142c113e4a80f1811c0afe5b1fdab21eafc47bf1360330550`.
- Observation cutoff `2026-09-13T17:45:00.103Z`; watermark
  `8562d037560f4cec7529b51b2229eb593dc92dc186bb63e81a2d0f8fdf3e33e4`.
  This is the saved synthetic clock, not a live recording timestamp.
- Suite hash `a58137ad7a59377cdc110af3c917b8edecc295c280dac6d2a3bd6ae2026def77`;
  frozen-entry hash
  `70145957a2ee8d003bc95aaf5a9d2ab04d9b1c942ced1e1a4172861ce5c5d4fe`;
  observed-census hash
  `ed42e63c213ab9953d5901da41a19107dedf5f20625b74744309f8eb6691632e`.

There are **zero actual human labels**, no label revisions, and no separately
observed live-model/fake-provider or live-provider cohort. Their M1–M7 values
are unavailable, not passing zeros. Legacy monitor-v1 synthetic checker results
remain historical in [the monitor receipt](../tools/monitoring/verification.md)
and [the dated audit](../ideation/reliability-implementation-audit.md); their
tests and fixture assertions are not added to this cohort.

## Frozen census and observed coverage

The saved census contains **92 planned entries**, **75 registered**, **75
attempted**, **75 assessed**, **0 passed**, **71 failed**, **0 pending**, **4
unverified**, **0 setup-failed** and **17 unrun**. Operational and assessment
counts overlap: `75 attempted + 0 setup-failed + 17 unrun = 92 planned`;
`0 passed + 71 failed + 0 pending + 4 unverified = 75 assessed`.
All 75 observations are retained; none were excluded or superseded.

- Baselines: **18 planned, 16 attempted**; 15 failed, one unverified, two unrun.
- Repetitions: **24 planned, 16 attempted**; 16 failed, eight unrun.
- Variants: **46 planned, 43 attempted**; 40 failed, three unverified, three unrun.
- Repair legs: **4 planned, 0 attempted**, all four unrun.

Thus **32/42** baseline/repetition slots were attempted, with no passing
baseline/repetition result. Only **16/18** family baselines ran; extra variants
do not replace the missing replay and successful-recovery baselines. The five
required live cases—golden, replay, stale approval, draft verification and safe
block—are each `not_run` with `live_account_preflight_not_run`.

The 17 unrun entries retain these original reasons:

- `pg-f05-baseline` and `pg-f05-repeat-1` through `pg-f05-repeat-4`:
  `parent_state_not_bound` (five replay slots).
- `pg-f09-baseline` and `pg-f09-repeat-1` through `pg-f09-repeat-4`:
  `recovery_not_implemented` (five successful interrupted-write recovery slots).
- `pg-f04-prompt_paraphrase`: `prompt_variant_not_bound`.
- `pg-f16-human_exact_match` and `pg-f16-human_conflicting_match`:
  `human_edit_schedule_not_implemented`.
- `pg-f03-contact_correction` and `pg-f06-owner_correction`:
  `repair_parent_state_not_bound`.
- `pg-f10-permission_repair` and `pg-f18-partial_owner_repair`:
  `parent_state_not_bound`.

Optional B08 successful recovery remains deferred. A safe stop in a separate
unknown-write variant does not satisfy its successful-recovery contract. **G5
coverage remains incomplete**, including all five live cases and human labels.

## M1–M7: raw units and denominators

Every value below belongs only to the synthetic/mock/fake cohort and versions
above. Denominators follow frozen metric eligibility, so they need not equal
the 75 attempted entries. The private detail retains all contributing attempt
IDs, original outputs, assessment/evidence revisions and excluded-input records.

- **M1, execution attempts: 0/18 (0%)** eligible attempts passed every required
  execution, outcome and quality condition. Failures before approval stay in
  this denominator. Expected safe blocks and no-affected cases do not increase
  this completed-work numerator.
- **M2, tool attempts: 2994/3003 (99.7003%)** succeeded; **first logical calls:
  1095/1102 (99.3648%)** succeeded. Retries and unresolved/error outcomes retain
  their original counts. A successful fake-provider response does not establish
  an independently verified business effect.
- **M3, required predicates: 0/1121 (0%)** independently confirmed;
  **mutation acknowledgements: 0/71 (0%)** independently corroborated. Missing
  evidence remains in the denominator. This summary does not reinterpret
  uncorroborated acknowledgements as verified writes.
- **M4, read retry: 0/3** eligible attempts with confirmed recovery;
  **accepted write: 0/2**. The saved fallback `none` class is **0/0, N/A**.
  Required recovery facts are unavailable in the monitor-v2 input, so the two
  nonempty zero numerators are unverified recovery results, not a measured
  classification of every attempt as a failed recovery.
- **M5, excess applied creations: 0/0, N/A**. Applied-creation history is
  unavailable. Neither zero duplicate creations nor zero affected runs has been
  established; the public `duplicates` counter is unavailable.
- **M6, wall/wait/active latency:** each has **0 uncensored samples and 75
  censored samples**. Median and maximum are **N/A milliseconds** for all three
  dimensions. Raw censored durations remain in the private detail. Test duration,
  synthetic timestamps and censored elapsed times are not verified completion
  latency.
- **M7, first proposals:** analyst **0/54**, drafter **0/54**, auditor **0/54**
  with passing original-quality evidence. All three retain 54 eligible attempts,
  including missing or failed outputs. Actual human labels are zero, so these
  values do not establish human-rated 0% quality. The saved role assessments are
  analyst **3 failed/51 unverified**, drafter **7 failed/47 unverified**, auditor
  **0 failed/54 unverified**. These failure flags coexist with missing semantic
  review; no role has a semantic pass.

M2 by app and read/write operation, preserving separate attempt and first-call
fractions:

- GitHub reads **229/233** attempts and **229/233** first calls; writes
  **11/11** attempts and **11/11** first calls.
- HubSpot reads **2001/2004** attempts and **354/355** first calls; writes
  **35/35** attempts and **35/35** first calls.
- Slack reads **578/578** attempts and **327/327** first calls; writes
  **52/52** attempts and **52/52** first calls.
- Gmail reads **74/74** attempts and **73/73** first calls; writes **14/16**
  attempts and **14/16** first calls.

Selected-plan quality is separately **0/54 for each role**, with no actual human
labels. One regenerated output is recorded; it does not replace its original
proposal in M7. Human corrections, auditor misses and auditor false blocks are
unavailable. Individual unsupported factual-claim count is unavailable; the
legacy proposal-level proxy is zero and is not a claim count or evidence that
all language was supported. Correct/incorrect safe-block rates and individually
measured incorrect-recipient counts are also unavailable in this report.

## Completion claims and safety findings

Q05 aggregates the saved Q03 claim verdicts. It does not re-evaluate claim truth.
There are **24 unique emitted success claims**:

- **21/24 premature** success claims.
- **0/24 independently outcome-contradicted** claims.
- **21/24 false-completion union**, deduplicated by claim ID across premature
  and outcome-contradicted sets.
- **24/24 independent outcome verdicts unverified**; **0/24 confirmed**.

The absence of a corroborated contradiction does not establish correctness.
Missing emission-time evidence leaves outcomes unverified; later state changes
alone cannot prove what was true at emission. The legacy monitor-v1
premature-only counter retains its older meaning and is not mixed into this
union.

Recorded forbidden-effects and approval-bypass counters are each **0**. They
do not close safety gates: the report preserves **509 critical finding records
across 71 attempts**, including **73 `undeclared_mutation`**, **113
`verification_readback_missing`**, **54 `next_write_before_verification`**,
**11 `summary_before_verification`**, **23
`checker_protected_record_changed_or_missing`** and **17 `outcome_mismatch`**
records. These are finding records, not distinct physical violations or live
provider effects; one attempt can contribute multiple findings. The full list
and event references remain in the restricted detail.

## All 38 saved gaps

These codes are preserved verbatim from the saved report:

```text
actual_human_labels_missing
auditor_detection_labels_unavailable
census_contains_failed_attempts
checker_export_invalid
checker_protected_record_changed_or_missing
checker_subset
checker_terminal_status_mismatch
claim_outcome_unverified
completion_verification_missing
creation_facts_unavailable_in_monitor_v2
deadline_exceeded
first_proposal_failed
first_proposal_labels_missing
human_edit_schedule_not_implemented
independent_outcome_bundle_missing
model_retry_configuration_unavailable
mutation_acknowledgement_unverified
next_write_before_verification
no_affected_evidence_missing
orphan_or_duplicate_stage_result
outcome_mismatch
outcome_scope_or_collection_incomplete
parent_state_not_bound
premature_success
prompt_variant_not_bound
provider_call_unresolved
recipient_count_unavailable_in_monitor_v2
reconciliation_unresolved
recovery_facts_unavailable_in_monitor_v2
recovery_not_implemented
repair_parent_state_not_bound
semantic_labels_missing
source_evidence_missing
summary_before_verification
tool_budget_exceeded
undeclared_mutation
undeclared_reconciliation
verification_readback_missing
```

## Restricted receipts and R02 comparison

On the implementation machine, the private Q05 directory is
`/tmp/promiseguard-q05/.local/q05-final/`. Its four files use stem
`report-5bb5b9127b0b2034befe53cd00d0381f146a68e267d84c2375453eee6c52dc85-r1`:

- `.json`: byte SHA-256
  `ea7a61a2374da86b9eec1bffdebe8311489e2e8bbc401e5d04787554d1d2ac62`.
- `.summary.json`: byte SHA-256
  `301b93f7b84787c2f5ce1483633c90c3b4769d22b772f256911ae929315c5f70`.
- `.detail.json`: byte SHA-256
  `ed32948ef81a1790a5244bc057fc251f96aef3150a0598056d3c546ce2d619c5`.
- `.md`: byte SHA-256
  `7c2480aa98e0402d147faf5fb4dee3826d36c96519f497627dd307e60012166b`.

The embedded report payload SHA-256 is
`c53b756f131de856b1a133b2f5e19c16bd193d3eb8136e4e7cf9a222aa1edb38`;
it hashes canonical `{summary, detail}`, not the complete JSON file bytes.
The input census is `/tmp/promiseguard-q04/.local/q04-final/census.json`,
byte SHA-256 `bf16421d84c725ee1380d1cfbe182cb4d29e3342dfba17a3aee33491e3b97198`.
Its sibling immutable revisions, result receipts and databases retain the
original 75 attempts. The portable source recipes and prior command receipts
are in the [Q04 receipt](../ideation/implementation-plan/commits/Q04.md),
[Q05 receipt](../ideation/implementation-plan/commits/Q05.md) and
[evaluation CLI guide](../tools/evaluations/README.md).

These are restricted local references, not public download links; a fresh clone
does not contain the raw evidence. Access requires the evidence owner's private
storage. All four inspected Q05 files retained mode `0600` during R02 review.

On September 14, 2026, the R02 Codex evaluation reviewer read the saved files,
recomputed the report payload and file hashes, compared saved summary/detail
projections with their parent report, checked the unique attempt/claim counts,
and compared the displayed aggregate numbers above with the report. This was
read-only inspection: no workflow cohort or provider call was rerun and no
human semantic labels were created. A browser-rendered report comparison,
live evidence, original-output human review and final release-gate acceptance
remain unverified.
