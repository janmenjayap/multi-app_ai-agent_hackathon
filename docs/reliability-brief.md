# PromiseGuard reliability brief

**R02 freeze: September 14, 2026; conventions 1.2.** The packaged application
source is `fa148667016be9f3c778bc76ad9c8ee232f9151d`. This release documents a
working simulated workflow and adverse evaluation evidence. It does **not**
establish a successful live four-app product or independently verified AI quality.
The [release manifest](release-manifest.json) separates the packaged source from
the earlier execution/report sources, and records which checks were run at freeze.
The final freeze includes Gemini runtime migration
`25ba4727f0425849a8d10f1fd3b04dd6abcf8c7f`. The earlier failed Q04/Q05 cohort
was not rerun after that migration and does not measure Gemini output quality.

The saved Q04/Q05 cohort contains **92 planned slots, 75 attempted/assessed,
0 passed, 71 failed, 4 unverified and 17 unrun**; setup-failed and pending counts
are both zero. Its mode is `synthetic_fixture`, model `mock`, providers `fake`.
Actual human semantic labels are **0**. These are observed failures and missing
evidence, not successful product scenarios. The complete raw denominators,
failure categories and metric limits are in the
[evaluation summary](evaluation-summary.md).

## Evidence identity

All cohort statements below refer to the preserved [Q04 execution receipt](../ideation/implementation-plan/commits/Q04.md#executed-scenario-receipt)
and [Q05 report receipt](../ideation/implementation-plan/commits/Q05.md#saved-q04-measurement-report):

- Q04 implementation: `fbc04a5750ec0aa1f87fb24c29ca7937c1dc942e`;
  actual execution source:
  `source-sha256:c3bef035b6a54b61b8f7b29eeba5b880b6676e47bd1c7f39a60fa441ba07059c`.
- Q05 report implementation: `5b250645eef9ccf15feaf69d97ce1470776b4dc0`;
  report-source dirty digest:
  `49abc5f58bdc692142c113e4a80f1811c0afe5b1fdab21eafc47bf1360330550`.
- Report ID: `report-5bb5b9127b0b2034befe53cd00d0381f146a68e267d84c2375453eee6c52dc85`,
  revision 1, `monitor-v2`; synthetic observation cutoff
  `2026-09-13T17:45:00.103Z`. The cutoff is a fixture clock, not the wall-clock
  date of live execution. Canonical report-payload SHA-256:
  `c53b756f131de856b1a133b2f5e19c16bd193d3eb8136e4e7cf9a222aa1edb38`.
- Restricted source files remain in
  `/tmp/promiseguard-q04/.local/q04-final/census.json` and
  `/tmp/promiseguard-q05/.local/q05-final/` with the report ID plus `-r1`
  and `.json`, `.md`, `.summary.json`, `.detail.json` suffixes. These local
  evidence files are outside Git and require separate authorized access;
  a fresh clone contains their receipts and reproduction instructions, not
  private snapshots. Re-execution creates new evidence identities.

## 1. Original AI decision quality

The role pipeline persists first analyst, drafter and auditor output references,
source digests and validation results. Retaining original bytes makes review
possible; schema validation, a model auditor's agreement and Slack approval do
not establish grounding or usefulness. Q05's trusted review intake requires
independently authenticated or actual interactive review provenance. Imported
`human` strings and Codex code reviews do not supply human semantic labels.
See [Q05's implementation receipt](../ideation/implementation-plan/commits/Q05.md#implementation-receipt--september-14-2026).

For the saved S1 baseline `pg-f01-baseline`, evaluation attempt
`470a927e-3fa0-4214-a5a8-855724ccec93`, the original mock drafter output
`output-01efe296-f2b8-439a-870b-28f7a61a0920` has raw-output SHA-256
`71e8abfe0f11bddc977b85f4b976324d0f3ef71f9d8a4f93b6718abd65082366`.
Its source digests and all three original role records are in the restricted
Q04 result `artifacts/q04-82f56c64db66cbcbe66571dba8693b23759c15a949aa0093b2e5ad7201700878.json`.
The selected and first-proposal semantic assessments remain unverified.

Across the cohort, M7 is **0/54 for each role**, with zero actual human labels.
This is zero verified first-proposal passes over eligible role slots, not a
measured 100% error rate or real-model benchmark. Missing/invalid original
outputs remain in the denominator; corrections cannot replace them. Individual
unsupported-claim rates, human correction rates and independently measured
auditor detection/false-block rates remain unavailable.

## 2. Runtime controls and trace evidence

[R01](../ideation/implementation-plan/commits/R01.md#r01-implementation-receipt--september-14-2026),
implementation `bacb8ea4e2c340f547fe2a081c6836b911fe24d3`, recorded three passing
grouped walking-skeleton tests. The named simulated S1/S2 test in
[walking-skeleton.test.ts](../tests/scenarios/walking-skeleton.test.ts) exercises
the real durable graph with scripted model replies and stateful fake providers:
three role calls precede approval, restart preserves those calls, five effects
are verified, and replay preserves the run, model-call count and provider
history. Its wrong-recipient and phantom-Slack fault cases stop at
`failed_partial` without a whole-run success claim. Detection after an injected
bad effect does not mean the bad write was prevented.

The final R02 simulated demo on packaged source
`fa148667016be9f3c778bc76ad9c8ee232f9151d` records run
`cc7c3705-4bfe-4bb0-a446-44a52fda6a76`, three mock role calls, five verified effects
and replay of the same run with zero excess creates. Its local receipt
`.local/r02-final/demo.json` has file SHA-256
`0d18f76f19139448eca43f7aa35a78621ff5503fef8b474a6aa5ef438de2739c` and retains
`frozen_oracle_content_binding_unverified` despite complete S0/S1 collection.
This smoke is separate from the Q04 census and adds no measured cohort attempt,
live model/provider call or human label. The manifest retains the preliminary
smoke at the earlier source separately.

This bounded runtime evidence is separate from the saved frozen-census verdicts.
Q04 S1 reports product status `completed` but assessment `failed`; its required
effect identity bindings do not match the frozen oracle. Q04 also retains
orphan/duplicate stage-result findings and the zero-write stale-approval status
bug. For example S5 `pg-f06-baseline`, attempt
`5fd0ffc8-eb5a-4a3d-abe0-13382fdb1b86`, remains failed. R02 does not rewrite
expectations or relabel these outcomes to obtain a pass.

[U02](../ideation/implementation-plan/commits/U02.md#reviewed-implementation-and-verification-receipt),
implementation `93a6cdfe16eb9692dc683879fcba88520e18f9c9`, has historical
component/browser receipts for authenticated HTTP, durable run identity,
session expiry and three viewports. Its controlled graph and rendered metric
fixtures are synthetic. They do not demonstrate this Q05 report in an
authenticated real S1/S2 browser session; see the [demo runbook](demo-runbook.md)
for the remaining rehearsal and delivery checks.

## 3. Frozen expectations versus independently read app state

Q01 defines expectations before dispatch. B07's inline verifier gates workflow
progress; Q02 separately collects scoped S0/S1 records and provenance. In R01's
simulated S1/S2 test, independently read fake-provider fields establish a task,
note, draft, GitHub comment and final Slack verification. The test checks exact
approved draft bytes, the designated recipient, empty Cc/Bcc, task/note
associations and unchanged protected Beta records. That is local fake-provider
control evidence at the R01 source, not a live account receipt.

The frozen Q04 S1 result cited above retains independent snapshots but fails
all five `required_*` artifact checks and the expected-to-observed binding.
Some approved-plan checks pass, including draft recipient/Cc/Bcc/subject;
these subsets do not satisfy the unchanged independent scenario oracle.
Missing protected-record evidence remains a gap elsewhere in the cohort.

For the adverse draft case `pg-f11-baseline`, attempt
`b1149d2e-72ae-4837-8d4e-717b269ea99f`, product status is `failed_partial` and
the evaluation is failed. Restricted result
`artifacts/q04-28aa50a31f0fee6380868712bc848c2f518e6903e612c46e5898fa36d4dc7289.json`
preserves the injected wrong-recipient provider state. Provider acknowledgements
alone earn no corroboration credit: the cohort's M3 confirmed mutation
acknowledgements are **0/71**. Missing applied-creation history leaves M5
**N/A**, not zero duplicates.

## Completion claims and remaining gates

The [historical monitor/checker receipt](../tools/monitoring/verification.md)
and [validation hashes](../tools/monitoring/validation.sha256) retain their
original scope: 95 monitor tests, 34 checker tests, and 115 assertions on one
synthetic checker fixture. `monitor-v1`'s `falseCompletion` is the
premature-only counter relative to supplied events. It may be zero while final
state checks fail; it is not comprehensive false-completion evidence.

At the packaged source, [Q03 claim assessment](../src/server/monitoring/claim-verdicts.ts)
from implementation `df9e0102d8b6e932138a96dad5ece64813669dea` implements
`monitor-v2`: `falseCompletion` is the union of premature claim IDs
and independently outcome-contradicted claim IDs. An overlapping ID counts
once; remeasurement does not create another claim. A later repair does not erase
premature emission. Artifact-summary scope excludes its own pending Slack
write; whole-run scope includes final Slack readback. `no_affected` uses
complete source/selection/no-write evidence instead of a plan or Slack artifact.

Independent confirmation/contradiction requires evidence bound to the claim,
runtime attempt, plan where applicable, complete scope and a state interval
covering emission within the frozen age/settling/cutoff limits. Later S1 state
alone cannot establish earlier truth. Insufficient timing remains unverified;
later drift cannot retroactively prove a previously correct claim false.

The saved cohort has **24 unique success claims: 21 premature, 0 independently
outcome-contradicted, 21 in the deduplicated union and all 24 outcome-unverified**.
S1's two claim IDs are `f1b3b554-62d6-4a57-a7d6-893e138bee89` and
`a31afaec-0502-4fd3-bd21-b0c3545a7b10`; both retain scope/predicate and
claim-time-evidence gaps. Zero contradictions is therefore not verified
correctness, and these classifications are evaluator findings rather than proof
that all 21 were observed false in real provider state.

Live three-role/four-app S1/S2, authentic human approval and semantic labels,
full planned evaluation, claim-time corroboration and delivery evidence remain
open. Frozen S2 `pg-f05-baseline` is unrun (`parent_state_not_bound`);
successful-recovery S4 `pg-f09-baseline` is unrun (`recovery_not_implemented`).
The R01 replay test does not fill those census slots. Optional B08 recovery,
U03 inspection and Q06 hosted LangSmith evidence are unclaimed; MCP is disabled.
The [release manifest](release-manifest.json) records each gate separately.
No production-scale, customer-send, exactly-once or successful-submission claim
is made by this documentation freeze.
