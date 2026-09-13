# PromiseGuard demo runbook

Release preparation: September 14, 2026; global conventions **1.2**. The
[release manifest](release-manifest.json) identifies the frozen source and checks.
This runbook documents the runnable **synthetic** workflow and the remaining
connected-demo prerequisites. It does not establish live four-app success,
human quality review, authenticated rehearsal, video playback, or submission.

## 1. Reproduce the available workflow

Run from the repository root with Node **24.21.0** (the package accepts
`>=24.15.0 <25`). A new checkout needs `npm ci`.

```bash
node --version
npm ci
npm exec -- tsc -p tools/demo/tsconfig.json
node .local/demo-build/tools/demo/run.js
```

The [demo runner](../tools/demo/run.ts) executes the actual workflow and all
three bounded role wrappers with mock responses and stateful fake providers.
It starts the golden fixture, waits for a simulated Slack decision, restarts,
approves, verifies the artifacts, and reopens the same incident. It creates
temporary databases and removes them on exit. No credentials are needed.

**Final R02 receipt:** at
`fa148667016be9f3c778bc76ad9c8ee232f9151d`, on Node 24.21.0/npm 11.19.0,
Linux x64, a clean
`npm ci --offline --cache /tmp/promiseguard-npm-cache --no-audit --no-fund`
installed 238 packages. `npm run typecheck`, `npm run build`, and the two demo
commands above all exited 0. Checks began at `2026-09-13T23:43:47.358857Z`
(September 14 IST); command results and hashes are retained in
`.local/r02-final/checks.json` and the release manifest. Run
`cc7c3705-4bfe-4bb0-a446-44a52fda6a76` produced three model calls, five verified
effects, same-run replay and zero excess writes. S0/S1 collection was complete,
with `frozen_oracle_content_binding_unverified`, zero actual human reviews and
live S1/S2 unrun. The saved `.local/r02-final/demo.json` SHA-256 is
`0d18f76f19139448eca43f7aa35a78621ff5503fef8b474a6aa5ef438de2739c`.
Earlier checks at `8722598eb1c83fc81c6a6c36930899f5da811772` remain under
`.local/r02/` as historical evidence before the Gemini migration. Private local
logs are not bundled in a new checkout.

Read the printed JSON, including these fields:

- `evidenceMode: "synthetic_fixture"`, `liveProviders: false`, and
  `actualHumanReviews: 0` identify this evidence.
- `waiting: "awaiting_approval"` and `completed: "completed"` show the product
  transitions. `modelCalls: 3` is the total across the initial run and replay.
- `verifiedEffects` contains five effects in `verified` state: HubSpot task,
  HubSpot note, Gmail draft, GitHub impact comment, and Slack summary thread.
- `replay.sameRun: true`, `replay.disposition: "reopened"`, and
  `replay.excessWrites: 0` show the same run was reopened without new mutations.
- Read `independentCollection.gaps`, `quality`, and `liveS1S2` as well.
  Completed runtime readbacks do not resolve the frozen-oracle binding gap or
  establish independently reviewed model quality. `liveS1S2` remains `unrun`.

To retain this synthetic JSON locally, replace the final command with:

```bash
umask 077
mkdir -p .local/r02-reproduction
node .local/demo-build/tools/demo/run.js > .local/r02-reproduction/demo.json
cat .local/r02-reproduction/demo.json
```

This is an alternative capture command, not a request to rerun it after every
documentation edit. Its JSON does not preserve the temporary database's full
source/output or readback evidence. `node .local/demo-build/tools/demo/run.js
--review` is available for an actual interactive original-output review; it
must run in a terminal, and the default runner still deletes its databases.
An evaluation that needs durable review receipts must retain a configured
harness/evaluation directory. Do not turn simulated approval into a review label.

The [R01 receipt](../ideation/implementation-plan/commits/R01.md#r01-implementation-receipt--september-14-2026)
records the prior focused assertions for exact approved draft bytes, recipient,
task ownership/associations, unchanged Beta records, restart, and replay. Those
assertions are more detailed than the CLI summary; their recorded result is
historical synthetic evidence.

## 2. Safe block and console preview

The existing harness can also reproduce a synthetic ambiguous-recipient block.
This optional command is checked against the exported harness API but **not run
for R02**; the same case is covered by the historical R01 receipt.

```bash
node --input-type=module <<'NODE'
import { createDemoHarness } from './.local/demo-build/tools/demo/run.js';
const harness = await createDemoHarness({ suiteEntryId: 'pg-f03-baseline' });
try {
  const run = await harness.startRun();
  console.log(JSON.stringify({
    evidenceMode: 'synthetic_fixture',
    runId: run.runId,
    status: harness.services.repository.getRun(run.runId).status,
    modelCalls: harness.model.calls.length,
    protectedCreates: harness.fake.observer.history().filter(row =>
      row.stage === 'scored' && row.action === 'create' && row.app !== 'slack').length,
    planCreated: harness.services.repository.getPlan(run.runId, 1) !== null,
  }, null, 2));
} finally { await harness.close(); }
NODE
```

Expected: `safely_blocked`, zero model calls, zero protected creates, and no
plan. This is a harness invocation, not a browser or real-provider rehearsal.

Start the separate visual preview:

```bash
npm run dev:web -- --host 127.0.0.1 --port 5173
```

Open **http://127.0.0.1:5173/?preview=1**. Select `Waiting for Slack approval`,
`Completed · assessment pending`, `Safely blocked · zero writes`, and
`Failed partial · accepted, unknown, unattempted` as useful examples. These
are explicitly synthetic display fixtures, with invented links, IDs and
assessment values. They do not show the CLI run or prove that the illustrated
provider actions occurred. The preview's service/contact examples differ from
the CLI fixture; do not splice them together as one observed run.

## 3. Read the measured report

Use [evaluation-summary.md](evaluation-summary.md) for the release's recorded
counts and [reliability-brief.md](reliability-brief.md) for their limits. The prior
[Q05 receipt](../ideation/implementation-plan/commits/Q05.md#implementation-receipt--september-14-2026)
records **92 planned, 75 attempted, 0 passed, 71 failed, 4 unverified, 17 unrun**,
with zero actual human labels. These synthetic cohort results remain separate
from one successful runtime demo.

Where the original private Q04 evidence is available, the implemented commands
below rebuild a report from saved evidence without executing the workflow:

```bash
npm exec -- tsc -p tools/evaluations/tsconfig.json
node .local/evaluation-build/tools/evaluations/report.js \
  --input /tmp/promiseguard-q04/.local/q04-final \
  --output .local/q05-reproduced
```

The input is the historical receipt's local path; it is **not bundled** in a
fresh clone. Substitute a retained Q04 evidence directory only after checking
its census/source identities. New report output records the current reporting
source, so it is not automatically the original frozen report. R02 does not
rerun this command or the scenario cohort. A nonzero exit can correctly report
failed, unverified, or unrun cases; inspect the generated data and gaps.

The command prints paths to immutable JSON, Markdown, summary, and detail
artifacts. Read the emitted Markdown locally and compare any connected UI's
summary values with the exact emitted `.summary.json` bytes. Include versions,
cutoff, cohort counts, claim verdicts, and missing labels. Zero denominators
remain N/A. This saved-versus-rendered collected-report comparison is **unrun**.
Never replace these results with the preview's illustrative scorecard.

For the separate historical monitor/checker demonstration, the existing
[monitor guide](../tools/monitoring/README.md) and
[checker guide](../tools/reliability/README.md) contain their own synthetic
examples. Their receipts do not establish application or live-provider outcomes.

## 4. Connected HTTP application prerequisites

The connected application is **not ready from `.env.example` alone**. Copy it
only when no local `.env` exists, then configure the server-owned values:

```bash
cp -n .env.example .env
```

1. Supply a trusted local `.mjs` module as `PG_WORKFLOW_MODULE`, exporting
   `createCompositionOptions(config)`. Its `buildWorkflow(services)` must supply
   the graph, frozen evaluation/preflight setup, source-selection policy,
   approval policy, and driver inputs. See
   [CompositionOptions](../src/server/composition.ts) and the
   [R01 integration receipt](../ideation/implementation-plan/commits/R01.md).
   This account-specific module is not bundled.
2. Supply `auth.resolveSession` with trusted operator identity, expiry,
   repository/run permissions, and CSRF token, following
   [the session contract](../src/server/api/auth.ts). Also provide the browser's
   authenticated shell containing `<meta name="csrf-token" content="…">`, or
   an equivalent reviewed injection into the client's token getter. The
   default static shell does not issue sessions or inject tokens. There is no
   bundled sign-in workflow; do not bypass authentication for the recording.
3. Configure `PG_MODEL_MODE=live`, `GEMINI_API_KEY`, and an explicit
   `GEMINI_MODEL`; `.env.example` selects `gemini-3.8-flash` and lists optional
   `GEMINI_MODEL_ANALYST`, `GEMINI_MODEL_DRAFTER`, `GEMINI_MODEL_AUDITOR` and
   bounded call settings. The committed adapter uses a direct server-side
   Gemini `generateContent` request; quota or compatibility has not been
   verified by this release. Use synthetic disposable inputs for model smokes.
   Configure `PG_ADAPTER_MODE=rest` and all four provider account credentials,
   immutable scopes and Slack human approver IDs. HubSpot additionally needs
   portal-specific `PG_HUBSPOT_MAPPING_JSON` (or the injected mapping) validated
   against [HubSpotMappingSchema](../src/server/adapters/hubspot.ts).
4. Keep ledger, checkpoints and evidence paths distinct. Mock models/fake
   adapters instead require `PG_FIXTURE_ID` and their injected clients.
   Model and adapter modes are independent; MCP stays disabled.

After those prerequisites have been supplied and reviewed:

```bash
npm run build
npm start
```

Open **http://127.0.0.1:3000** in the authenticated operator session. Missing
`PG_WORKFLOW_MODULE` stops startup explicitly. A successful build or health
request does not prove sessions, provider access, or a completed workflow.
Connected startup and authenticated S1/S2 are **unrun for R02**.

## 5. Model and provider smoke commands — unrun

The commands below match the committed runners; they were **not executed for
R02**. See the [model guide](../ideation/implementation-plan/07-agent-spawning-and-llm-integration.md)
and [app integration guide](../ideation/implementation-plan/08-mcp-api-and-external-app-integration.md).
The migrated `npm run smoke:model` script is present in `package.json` and
invokes the same `model-compatibility-smoke-v2` runner. That npm script does not
load `.env`; the direct Node commands below explicitly load it. The earlier
OpenAI configuration described in planning guides is historical: the executable
release uses Gemini and `GEMINI_*` settings.

For a configured model, use a new absolute private receipt directory and invoke
each schema separately. These calls use synthetic compatibility prompts and
do not test the production role prompts or any provider:

```bash
umask 077
mkdir -p .local/model-smoke
chmod 700 .local/model-smoke
PG_MODEL_MODE=live node --env-file=.env --experimental-transform-types tools/smoke/model.ts \
  --mode live --role analyst --receipt-dir "$PWD/.local/model-smoke"
PG_MODEL_MODE=live node --env-file=.env --experimental-transform-types tools/smoke/model.ts \
  --mode live --role drafter --receipt-dir "$PWD/.local/model-smoke"
PG_MODEL_MODE=live node --env-file=.env --experimental-transform-types tools/smoke/model.ts \
  --mode live --role auditor --receipt-dir "$PWD/.local/model-smoke"
```

For provider smokes, build the server first if the current build is absent:

```bash
npm run build:server
```

These are manual operator commands for prepared disposable accounts. They create
real test artifacts; Slack posts and updates a review message and waits for a
real allowlisted human reply. R02 does not execute them, send messages, or clean
up provider records. Run them sequentially and retain private result receipts.

- **GitHub:** `.env` needs `PG_GITHUB_TOKEN`, `PG_GITHUB_REPOSITORY`, and the
  additional smoke-only `PG_GITHUB_INCIDENT_URL` pointing to a seeded valid
  disposable issue. The runner reads its evidence, creates/reads/updates one
  marked comment, and checks its unique lookup.

  ```bash
  PG_GITHUB_SMOKE_MUTATIONS=enabled node --env-file=.env tools/smoke/github.ts
  ```

- **HubSpot:** `.env` needs `PG_HUBSPOT_ACCESS_TOKEN` and
  `PG_HUBSPOT_PORTAL_ID`. Supply `.local/hubspot-smoke.json` matching the
  `SmokeManifestSchema` in [hubspot.ts](../tools/smoke/hubspot.ts): version 1,
  account/service, validated mapping, selected/protected commitment and
  company/contact/owner expectations, marked task, and marked note. This private
  portal-specific manifest is not bundled. The runner checks fields and
  association types, creates a task/note, then reads and checks their links.

  ```bash
  node --env-file=.env tools/smoke/hubspot.ts --manifest .local/hubspot-smoke.json --confirm-writes
  ```

- **Slack:** configure all five `PG_SLACK_*` values in `.env`, including a
  reader able to see actual human thread replies. The allowlisted human must
  reply in the posted test thread during the wait; this checks reply access,
  not approval of a product plan.

  ```bash
  node --env-file=.env tools/smoke/slack.ts --wait-seconds 300 --poll-seconds 60
  ```

- **Gmail:** configure client ID/secret, refresh token and expected mailbox in
  `.env`. The runner verifies mailbox identity, creates one draft addressed to
  that mailbox, reads its full recipient/content/draft state, and checks unique
  marker lookup. OAuth consent/token provisioning is external to this runner.

  ```bash
  PG_GMAIL_SMOKE_MUTATIONS=enabled node --env-file=.env tools/smoke/gmail.ts
  ```

`tools/smoke/providers.ts --manifest <private-path> --mode rest` is only a
manifest/preflight dispatcher: its CLI does not register provider checks and
reports `provider_check_not_registered` for configured entries. An exit code
of zero, missing mutation switch, or `unrun` status is not provider success.
Use the per-provider results above. Their direct adapter readbacks are distinct
from a persisted independent Q02 collection and do not prove a joined live run.

## 6. Accurate two-minute recording outline

The available recording can show a **synthetic workflow demonstration**. Keep
that label visible and describe the preview separately. This outline is planned;
R02 did not record or time a video.

- **0:00–0:15:** State the problem: an incident threatens a customer promise;
  PromiseGuard prepares approved follow-up and a draft. State the current demo
  uses mock model responses and fake app state.
- **0:15–0:40:** Run the CLI once or show that exact saved run's report. Explain
  the three role calls, approval wait, and restart. If showing the plan in the
  console preview, label it an illustrative UI example from a separate fixture.
- **0:40–1:05:** Show the five verified effect records and the Gmail draft
  boundary. Say “created and read back in the simulated provider state.”
- **1:05–1:20:** Show `sameRun`, `reopened`, `excessWrites: 0`, and the unchanged
  total of three model calls for replay.
- **1:20–1:35:** Show the safe-block harness result only if actually captured;
  otherwise show `Safely blocked · zero writes` as a labeled UI illustration
  and cite the prior R01 test receipt.
- **1:35–1:55:** Show the recorded evaluation summary, including failed,
  unverified, and unrun counts and absent human labels. Keep product completion
  distinct from independent assessment; do not quote preview metrics as results.
- **1:55–2:00:** State that live four-app verification and authentic approval
  remain unrun. Customer communication remains a draft.

For a later **connected live recording**, first replace the synthetic evidence
with one authenticated S1 run and its independently retained S0/S1 and review
receipts. Show the actual incident and selected/excluded commitments, three
stages, immutable plan/recipient/body/owner, authorized Slack thread and human
decision, ordered artifact links and fresh readbacks including the final Slack
summary. Then reopen S2 and compare all five saved provider IDs, mutation counts,
and model-attempt counts. Show an actually exercised safe block or tamper case
with its writes and status. Stale approval currently has a recorded status
mismatch; do not promise a `safely_blocked` result until a new receipt proves it.
This live rehearsal, its links and same-run browser report comparison are unrun.
Neither recording needs optional U03 or LangSmith export.

## 7. Rehearsal, privacy and delivery checks

These are **pending release checks**, not completed R02 receipts:

- Use a clean authenticated browser session. Check that expiry/401 and
  forbidden/403 stop commands and polling while retaining last-known product
  state; explicitly reconnect after authentication. Refresh/reopen must not
  create new execution or approval authority.
- Open each actual GitHub, HubSpot, Slack and Gmail artifact link as its intended
  reviewer. Confirm access and exact IDs/content; preview links are invented.
  Compare the saved report with the connected display, including N/A and gaps.
- Check keyboard access, visible focus, command-error focus, successful-open
  focus and detail-close focus restoration. Inspect **1440×900**, **768×1024**,
  and **375×812** for overlapping or clipped status, controls, pipeline, plan
  and evidence. Record at readable 1440×900 zoom with notifications suppressed.
- Inspect frames, terminal output, links, captions and exported receipts for
  tokens, cookies, private account IDs, customer content, raw MIME and personal
  data. Use only disposable/synthetic data or reviewed redacted evidence.
- Play the final video in a clean session, verify audio/text and duration
  **at most 120 seconds**, and record the exact video reference and check time.

The [U02 receipt](../ideation/implementation-plan/commits/U02.md#reviewed-implementation-and-verification-receipt)
records earlier synthetic component/browser checks and the three viewports.
It is not an authenticated four-app release rehearsal. R02 avoids repeating
those suites for this documentation-only change. The current Playwright server
configuration lacks the required workflow module; the aggregate browser command
is not a ready clean-start acceptance check.

The supplied README video reference is preserved without an access/playback
claim: [existing demo folder](https://drive.google.com/drive/folders/14ESRy4QuwqIl9Wugk_fxa5Ri6aTs7faz?usp=sharing).
Its contents, permissions, duration, audio and consistency with the frozen
release are **unverified**. Repository/video access and redaction of an actual
recording remain unchecked.

The [official public event page](https://multiappagenthackathon.com/) was checked
September 14, 2026. It directs teams to the calendar-event submission form,
requires one response per project/team with every team member's email, an
accessible GitHub repository, and a judge-accessible video no longer than two
minutes. It specifies the README sections 01 Project overview, 02 External apps
used, 03 Setup instructions, 04 Reliability testing, and 05 Demo video. The
published September 13 cutoff is 4:00 PM Pacific; the page's displayed
“Submissions open” banner does not establish late-entry availability. These
current public instructions supersede the older requirements snapshot where
they differ. The private calendar form, admission status and any participant-only
requirements were not accessed or confirmed.

The submission owner must verify the form and authorized links, include the
[reliability brief](reliability-brief.md), deliver the package if permitted, and
retain a separate confirmation. **No submission, publication, organizer message,
or delivery confirmation was made by R02.**
