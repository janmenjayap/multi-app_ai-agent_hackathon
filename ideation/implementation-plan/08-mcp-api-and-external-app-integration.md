# MCP, API, and external-app integration

**Status: implementation specification; no provider access or working integration
is claimed.** PromiseGuard's required apps remain GitHub, HubSpot, Slack, and
Gmail. Its release transport is typed REST adapters. MCP is an optional transport
extension behind those same contracts; it is not required to meet the four-app
promise. Read this with the [agent/LLM guide](07-agent-spawning-and-llm-integration.md),
[shared contracts](05-contracts-and-handoffs.md), and [reliability implementation](06-agent-reliability-implementation.md).

MCP means **Model Context Protocol**. Here its optional role is to carry a
backend's allowlisted tool request to an external server; it does not replace
the model API, app-specific permissions or PromiseGuard's approval contract.

The implementation locations below are proposed paths, unless their commit brief
states that an existing file is reused. This document adds implementation detail,
not completed commits, credentials, new external actions, or new hard merge gates.

Provider/protocol references were checked on **2026-09-14**. Documentation review
does not establish live account access; each owner must pin the actual API/SDK
versions and record its smoke result before claiming readiness.

## 1. Where external calls enter the application

1. **F01, P1 — configuration and dependency setup.** Add validated server-only
   environment handling in `src/server/index.ts` and empty examples in
   `.env.example`. P1 owns package/lock changes, including any later MCP SDK.
2. **F02, P1 — typed contract.** Freeze `GitHubAdapter`, `HubSpotAdapter`,
   `SlackAdapter`, and `GmailAdapter` in `src/shared/adapters.ts`, with separately
   injectable read, protected-mutation, and Slack-coordination capabilities.
   Freeze inputs, observed fields, completeness, and uncertainty before coding
   transports. These are application interfaces, not model tools.
3. **I01, P2 — shared transport.** Implement server-private HTTPS requests,
   pagination, errors, budgets, and attempt receipts in
   `src/server/adapters/common/{transport,pagination,errors}.ts`. Provider files
   implement only the narrow methods below. A generic transport request function
   is private to this layer and is never injected into a role or workflow node.
4. **R01, P1 — composition.** Construct transports/adapters in
   `src/server/composition.ts`; inject capabilities into `workflow/nodes.ts`, B05,
   B06, B07, and Q02. Construct separately controlled read clients for collectors.
   Persist IDs and evidence references in graph state; never serialize client
   instances, tokens, OAuth refresh tokens, or MCP sessions there.
5. **Source stage → B02 policy.** R01's `read_github_evidence` and
   `read_hubspot_candidates` nodes call I02/I03 and persist complete source
   snapshots. B02's `policy/{incident,selection,identity}.ts` functions validate
   and select from those snapshots. B02 remains deterministic policy code; it
   does not own a new collector module or make LLM calls.
6. **Approval stage → B05.** The Slack adapter posts/reuses the exact review and
   independently reads it and human replies. B05 binds workspace/channel/thread,
   actor, message version, plan revision/hash, decision, and expiry. Polling is
   deterministic server work; the UI resume/reconcile route grants no approval.
7. **Execution stage → B06.** After authentic approval and complete source
   refresh, B06 persists the effect claim and dispatch intent, then invokes
   HubSpot task → note → Gmail draft per commitment, followed by the incident
   GitHub comment. Every remaining protected write rechecks approval/hash/freshness.
   The model never chooses HTTP endpoints or submits provider payloads itself.
8. **Verification stages → B07/Q02.** B07 independently fetches created IDs and
   exact markers with read capabilities. Q02 makes separate S0/checkpoint/S1 reads
   over its frozen manifest, including protected unrelated records. Both preserve
   raw receipt references and coverage; neither accepts an executor success flag
   or create response as its independent observation.
9. **Finalization → R01/B07/I04.** Build the Slack summary from verified effects,
   update the same marked coordination thread, then independently read it back.
   Whole-run completion follows that readback. Complete zero-eligible selection
   needs no model calls, approval, or Slack artifact.

For example, the drafter receives an immutable projection of GitHub/HubSpot
evidence and produces text through A01. B03 binds that exact text to the plan;
B05 obtains human approval; B06 supplies those approved bytes to I05;
B07/Q02 retrieve and parse the actual Gmail draft. An LLM provider API call and
an external-app API call have different credentials, owners, attempts, and guards.

## 2. Configuration and access preparation

The following are project-defined configuration names for F01 to implement and
F02/R01 to consume. They are not environment variables already supported today.

- `PG_ADAPTER_MODE=fake|rest`: `fake` selects the injected stateful fixture
  providers from Q01's `tests/fakes/providers.ts`; `rest` requires all four real
  integrations. Q01's `tests/fixtures/world.json` supplies the initial fake world;
  R01/Q04 inject it through the same method contracts. Missing REST credentials
  or capabilities fail preflight; never substitute fake data. A model-driven run
  with fake apps is still not a live four-app run. Optional `mcp` is rejected until
  the extension in section 7 is implemented and reviewed.
- `PG_GITHUB_TOKEN`, `PG_GITHUB_REPOSITORY`: repository-scoped writer credential
  and exact `owner/repository` allowlist; preflight resolves and pins immutable
  repository ID. An optional `PG_GITHUB_READER_TOKEN` supplies a separate reader.
- `PG_HUBSPOT_ACCESS_TOKEN`, `PG_HUBSPOT_PORTAL_ID`: account-bound credential and
  expected portal. `PG_HUBSPOT_READER_TOKEN` may use reduced scopes where available.
  I03's smoke manifest records verified ticket properties, pipeline/status values,
  association labels/type IDs, owner IDs, and designated-contact mapping. Store
  this non-secret account mapping as reviewed runtime configuration supplied by
  composition, not model-selected fields or hard-coded example account IDs.
- `PG_SLACK_BOT_TOKEN`, `PG_SLACK_READER_TOKEN`, `PG_SLACK_TEAM_ID`,
  `PG_SLACK_CHANNEL_ID`, `PG_SLACK_APPROVER_IDS`: separate posting and observed-read
  capabilities, exact workspace/channel, and approved immutable human user IDs.
  The reader token must actually retrieve human replies in that channel. A
  configured reader capability does not prove that its credential is read-only;
  record the token's actual scope. Never infer read access from posting success.
- `PG_GMAIL_CLIENT_ID`, `PG_GMAIL_CLIENT_SECRET`, `PG_GMAIL_REFRESH_TOKEN`,
  `PG_GMAIL_MAILBOX`: server-side OAuth refresh and the expected mailbox.
  `PG_GMAIL_READER_REFRESH_TOKEN` optionally supplies a separately authorized
  read-only collector using the same configured OAuth client. Validate the mailbox
  identity, not just the existence of a token. Never put these in `VITE_*` values.
- I01 receives positive timeout, total-operation, pagination, record, response-size,
  and retry budgets from validated server configuration. F02 freezes their field
  names/types and R01 passes one operation budget through all underlying pages
  and retries. Provider-specific limits are checked during live preflight.

F01/R01 load runtime secrets from the deployment environment or secret store;
`.env.example` contains only names and empty placeholders. Keep private IDs,
account manifests, OAuth tokens, raw MIME, and live receipts outside committed
public examples. Token refresh stays in deterministic adapter/auth code. Refresh
failure is an authentication failure, not a reason to ask a model for credentials.

Account preparation belongs to the provider smoke tools and an operator setup
session before a scored workflow: restrict GitHub access to a disposable repo;
prepare one HubSpot account and its schema; install the Slack app into the test
workspace/channel; authorize a disposable Gmail user in a Cloud project with the
Gmail API enabled. For Gmail, register the OAuth client and exact redirect URI,
complete consent, request offline access, and retain the refresh token privately.
Use a local setup callback in `tools/smoke/gmail.ts` or the reviewed credential
provisioning flow; this plan does not add a public OAuth callback route to B04.
[Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
documents the OAuth mechanism; the account selection and storage rules here are
PromiseGuard design requirements.

## 3. GitHub — I02

**Code:** `src/server/adapters/github.ts`; tests and live exercise in
`tests/adapters/github.test.ts` and `tools/smoke/github.ts`.
**Consumers:** source nodes/B02, B06, B07, Q02, R01.

Use `https://api.github.com`, Bearer auth, the documented media type, and an
explicit tested `X-GitHub-Api-Version`. I02 records the chosen supported version
and response fixtures; never silently upgrade it mid-evaluation.

- Resolve repo with `GET /repos/{owner}/{repo}` and incident with
  `GET /repos/{owner}/{repo}/issues/{issue_number}`. Pin IDs and reject an incident
  URL outside the configured repository; requesting an arbitrary URL is not a
  supported operation. Retain issue state/body/times needed by B02.
  [GitHub issue retrieval](https://docs.github.com/en/rest/issues/issues#get-an-issue)
- Only for bounded references named by that incident, retrieve commits through
  `GET /repos/{owner}/{repo}/commits/{ref}`, deployment/status evidence through
  `/repos/{owner}/{repo}/deployments/{deployment_id}` and its `/statuses`, or workflow
  evidence through `/repos/{owner}/{repo}/actions/runs/{run_id}`. Enable only the
  families used by the frozen scenario; no repository crawler is added.
  [Commits](https://docs.github.com/en/rest/commits/commits#get-a-commit),
  [deployments](https://docs.github.com/en/rest/deployments/deployments#get-a-deployment),
  [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)
- `find` enumerates `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`;
  `create` uses `POST` on that route; `get` uses
  `GET /repos/{owner}/{repo}/issues/comments/{comment_id}`; exact approved updates
  use `PATCH` on the comment route. Preserve all exact-marker candidates and raw
  bodies, author IDs, issue identity, and `updated_at`.
  [Issue comment endpoints and permissions](https://docs.github.com/en/rest/issues/comments)

Use a GitHub App installation token or fine-grained PAT restricted to this repo.
Issues read is needed for reads; Issues write covers the permitted comment
mutations. Add Contents read, Deployments read, or Actions read only for selected
technical evidence endpoints. No code/merge/admin operations are exposed. The
underlying Issues write permission is broader than comment-only; the adapter is
the additional operation boundary, not a claim about provider-enforced scope.

Smoke gate: source identity → create one uniquely marked test comment → separate
GET → exact approved test update → complete marker lookup. Unknown create outcomes
must reconcile before another create; duplicates, wrong issue, or human edits are
not silently repaired. Any disposable cleanup is operator-only, outside the
worker interface and scored evidence window.

## 4. HubSpot — I03

**Code:** `src/server/adapters/hubspot.ts`; tests and live exercise in
`tests/adapters/hubspot.test.ts` and `tools/smoke/hubspot.ts`.
**Consumers:** source nodes/B02, B06, B07, Q02, R01.

Use Bearer auth against `https://api.hubapi.com`. This plan deliberately specifies
the documented v3 object/owner and v4 association routes below. HubSpot now also
documents date-versioned APIs; I03 must record and smoke the selected API family
without mixing schemas from different generations. Moving to another family is
a reviewed adapter mapping change, not a change to selection/approval contracts.

- Read complete ticket candidates with `GET /crm/v3/objects/tickets` and explicit
  `properties`, `associations`, `limit`, and `after`; read individual source
  tickets with `/crm/v3/objects/tickets/{ticketId}`. Use complete seeded account
  enumeration plus deterministic selection for the bounded demo. Optional search
  optimization must not drop malformed or potentially affected records.
  [Ticket API](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/tickets/guide)
- Retrieve exact associated company/contact records through
  `GET /crm/v3/objects/companies/{companyId}` and
  `GET /crm/v3/objects/contacts/{contactId}` with explicit properties. Retrieve
  owners through `GET /crm/v3/owners` and `/crm/v3/owners/{ownerId}`; use owner
  `id`, not its distinct `userId`, in approved effects.
  [Companies](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/companies/guide),
  [owners](https://developers.hubspot.com/docs/api-reference/legacy/crm/owners/guide)
- Preflight reads property definitions with `GET /crm/v3/properties/tickets` and
  relationship labels with
  `GET /crm/v4/associations/{fromObjectType}/{toObjectType}/labels`.
  Where object responses contain bounded/incomplete association lists, retrieve
  and paginate `/crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}`.
  Freeze direction-specific type IDs for task/note → company and commitment
  ticket. Do not copy example numeric association IDs into live configuration.
  [Properties](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide),
  [v4 association API family](https://developers.hubspot.com/docs/api-reference/legacy/overview),
  [association reads](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/get-associations)
- Task creation uses `POST /crm/v3/objects/tasks` with approved `hs_timestamp`
  due time, `hubspot_owner_id`, `hs_task_subject`, `hs_task_body`, status/type, and
  company/ticket associations. `get` uses `/crm/v3/objects/tasks/{taskId}`;
  complete marker lookup enumerates `/crm/v3/objects/tasks` and association pages.
  [Task properties and routes](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/tasks/guide)
- Notes use `POST /crm/v3/objects/notes`, with `hs_timestamp`, `hs_note_body`,
  owner and exact company/ticket associations. Retrieve `/crm/v3/objects/notes/{noteId}`
  and enumerate `/crm/v3/objects/notes` for exact markers. Tasks/notes have
  create/read/find capability only; protected updates/deletes are absent.
  [Notes](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/guide)

Prepare a single-account private/static-auth app or reviewed OAuth installation.
Start with `crm.objects.companies.read`, `crm.objects.contacts.read`, `tickets`,
and `crm.objects.owners.read`; confirm exact endpoint scopes for the account/API
family during I03 preflight. The documented v3 task-create endpoint requires
`crm.objects.contacts.write`; legacy activity APIs also use contact scopes. Record
the actual note-create/read requirements in the same capability receipt instead
of inventing `tasks.write`/`notes.write` scopes. Property/association inspection
must also pass with the installed scopes. These grants can be broader than the
worker's operations; neither `tickets` nor contact-write is described as a
read-only or task-only credential.
[Task-create permission](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/tasks/create-task),
[legacy scope catalog](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/scopes),
[current scope selection guidance](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes)

Smoke gate: verify the real ticket/contact/owner/property mapping; read both
eligible Alpha and protected Beta; create one test task and note with approved
associations; independently retrieve fields and association pages; enumerate exact
markers. Missing account features or owner/contact ambiguity stays a failed/unrun
gate. A readable company alone does not establish the task/note integration.

## 5. Slack — I04

**Code:** `src/server/adapters/slack.ts`; tests and live exercise in
`tests/adapters/slack.test.ts` and `tools/smoke/slack.ts`.
**Consumers:** B05 approval, R01 deterministic coordination, B07 readback, Q02.

Use Bearer auth and `https://slack.com/api/`. Post a marked review with
`POST chat.postMessage`; update only the app's stored message with `POST chat.update`.
Keep `channel`, message `ts`, and root `thread_ts` as exact strings. The bot needs
`chat:write` and membership in the chosen channel. No `chat:write.public` or
arbitrary-channel broadcast is required by this design.
[Posting](https://docs.slack.dev/reference/methods/chat.postMessage/),
[updating](https://docs.slack.dev/reference/methods/chat.update/)

Find a missing/replayed coordination message through bounded
`GET conversations.history` in the configured channel. Read the exact parent and
all replies with `GET conversations.replies?channel=...&ts=...`, following
`response_metadata.next_cursor`; preserve `user`, bot/subtype fields, edit metadata,
and read windows. A missing prior decision on a fresh complete read is not valid
approval. This is current message-state evidence, not a promise that Slack exposes
a complete audit history of every deleted/edited version.
[History](https://docs.slack.dev/reference/methods/conversations.history/),
[thread replies](https://docs.slack.dev/reference/methods/conversations.replies/)

Configure the appropriate history scope: `channels:history` for the selected
public channel or `groups:history` for a private channel. Current Slack reference
lists bot and user history-token support, but actual installation/channel access
must be proven with `PG_SLACK_READER_TOKEN`. B05 receives authenticated reply
observations, never model-authored approval. Pin workspace identity using the
authenticated installation/`auth.test` preflight; if actor verification additionally
uses `users.info`, declare `users:read` and test it. Human approver IDs come from
configuration, not the message body.
[Thread access](https://docs.slack.dev/reference/methods/conversations.replies/),
[authentication test](https://docs.slack.dev/reference/methods/auth.test/),
[user details](https://docs.slack.dev/reference/methods/users.info/)

Smoke gate: post/read/update/read the exact disposable thread and independently
retrieve a real allowed human's reply. Test HTTP 200 with `ok:false`, later-page
failure, wrong channel/actor, stale/edited decision, and acknowledged-but-absent
summary. I01 follows the installation's real `Retry-After`/rate constraints; UI
polling every two seconds does not imply calling Slack at that rate. No incoming
webhook or Events API subscription is required for the polling MVP.

## 6. Gmail — I05

**Code:** `src/server/adapters/gmail.ts` and `gmail-mime.ts`; tests/live exercise
in `tests/adapters/gmail.test.ts` and `tools/smoke/gmail.ts`.
**Consumers:** B06 approved draft creation, B07 independent MIME verification, Q02.

Use the authenticated mailbox at `https://gmail.googleapis.com/gmail/v1/users/me`.
`POST /drafts` creates a draft with base64url-encoded RFC-compliant MIME in
`message.raw`. Construct it only from the exact approved designated recipient,
subject/body, and deterministic effect marker. `GET /drafts/{id}?format=raw`
retrieves full MIME; preserve draft ID, nested message ID, all repeated/folded
To/Cc/Bcc headers, decoded subject/body, and actual draft state. A successful
create is only acknowledgement until separately fetched.
[Create](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create),
[get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/get),
[draft MIME format](https://developers.google.com/workspace/gmail/api/guides/drafts)

`findDraftsByEffectMarker` uses `GET /drafts` with complete `nextPageToken`
pagination followed by full retrieval of candidates and exact marker comparison.
For the bounded disposable mailbox, inspect every draft when marker indexing is
not proven; a custom MIME header is not assumed searchable. A Gmail `q` filter
is only an optimization backed by a tested completeness guarantee. List entries
alone do not contain the full body/headers needed for verification.
[Draft listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list)

The writer requests `https://www.googleapis.com/auth/gmail.compose`, accepted by
draft create/get/list. This OAuth scope can also send mail. PromiseGuard enforces
draft-only behavior with the narrow worker interface and method/path allowlist;
do not claim Google issued a draft-only token. No send/update/delete/generic Gmail
method is injected into B06 or the agents.
[Scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes)

Q02 may use a separately authorized `gmail.readonly` reader for draft retrieval
and scoped `/messages`, `/messages/{id}`, `/history` evidence. Record the pre-run
history anchor, page completeness, interval, and actual available permissions.
An expired/unavailable history anchor or unseen operation history leaves that
predicate unverified; the continued existence of a draft cannot prove that no
other actor sent a copy. This read capability never adds sending authority.
[Message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[history coverage and errors](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)

Smoke gate: verify OAuth mailbox identity, create a uniquely marked disposable
draft, list/find it, fetch full MIME through a separate read, and verify one To,
no Cc/Bcc, exact subject/body and draft state. Extra headers, multipart ambiguity,
missing drafts, duplicates, or revoked consent stay visible failures. The smoke
runner does not send mail; operator cleanup stays outside the worker/evaluation.

## 7. Optional MCP transport: exact insertion point and activation gates

No MCP server or tool name is assumed to exist. The deployed PromiseGuard backend
would be an MCP client calling an explicitly configured, authenticated MCP server;
that server in turn uses its separately authorized GitHub/HubSpot/Slack/Gmail
account. Installing an editor/assistant connector does not provide deployment
credentials, server configuration, or product runtime behavior. No plugin install
or user-account connection is part of this documentation change.

The optional extension sequence is **F01/F02 configuration/schema follow-up → I01
client follow-up → affected I02–I05 method mapping follow-up → R01 composition
and conformance**. These are follow-ups to existing owners, not completed commit
IDs or new mandatory MVP gates. Until they land, `PG_ADAPTER_MODE=mcp` must fail
startup as unsupported; ordinary release behavior stays `rest`.

1. **P1/F01:** add/pin a tested MCP client dependency and validate an allowlisted
   remote server URL, supported protocol version, server identity, credential
   reference, and mapping revision. Proposed extension-only environment names are
   `PG_MCP_SERVER_URL`, `PG_MCP_AUTH_TOKEN`, and `PG_MCP_MAPPING_PATH`; the auth token
   is issued for that MCP resource, not a provider access token blindly forwarded.
   The deployment handles refresh/revocation and provider account installation
   separately. HTTP authorization follows the chosen server's supported MCP/OAuth
   flow. Local stdio is an explicit deployment variant with reviewed command/env,
   never a command supplied by incident text or a model.
   [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
2. **P1/F02:** freeze the backend-only mapping shape: application method,
   configured server identity and credential reference, account scope,
   read/mutation classification, actual discovered tool name,
   argument projection, accepted input/output schema digests, provider-ID and
   pagination fields, and normalization rules. Provider tool descriptions are
   untrusted metadata, not authorization or workflow instructions.
3. **P2/I01:** introduce the proposed extension file
   `src/server/adapters/common/mcp-transport.ts` and
   `tests/adapters/mcp-transport.test.ts` in that reviewed follow-up. Initialize,
   negotiate a supported protocol, send `notifications/initialized`, then complete
   `tools/list` pagination before enabling required capabilities. Revalidate on
   reconnect or tool-list changes; missing tools/schema drift block the affected
   integration. Record negotiated versions; the linked 2025-11-25 specification
   is a concrete reference, not a claim that it is the newest protocol version.
   [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
   [tool discovery](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
4. **P2/I02–I05:** map each narrow application method above to a verified tool
   and exact argument projection within its existing provider file. For example,
   `findDraftsByEffectMarker` must still enumerate/get full drafts; a server tool
   returning only an email summary cannot implement it. Never use a guessed name
   such as `gmail_create_draft` as a live mapping. Tool names and schemas are
   captured from the actual server and reviewed before use.
5. **P2/I01:** dispatch only allowlisted `tools/call` operations. Validate both
   JSON-RPC errors and tool `isError`, then provider-specific payloads and full
   observed fields. Tool-list pagination and underlying provider-data pagination
   are different obligations. Preserve source/account/provider IDs and canonical
   attempt receipts regardless of transport. Tool annotations such as read-only
   hints never override the application's method allowlist or credential scope.
   [Tool calls and results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
6. **P2/I01, B06:** one total budget covers the MCP request and downstream provider
   work. On timeout/cancellation/disconnection after mutation dispatch, retain
   `unknown`; a cancellation notification does not establish rollback. Reconcile
   through independently observed exact-marker state before any further create.
   Disable hidden SDK/server mutation retry or require explicit trustworthy
   evidence of its attempts; a server that cannot meet this contract is unsuitable
   for protected writes. No transparent REST fallback after uncertain MCP mutation.
   [Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
7. **P1/R01:** select the reviewed implementation once at startup, inject separate
   reader/mutator projections, and close clients on shutdown. Run identical
   fake/REST-response/MCP contract counterexamples plus actual server/account smoke.
   Q02 retains independently controlled fresh reads and reports whether its
   transport/account provenance is shared; transport substitution alone does not
   establish independent ground truth.

Do not bind discovered MCP tools to LangChain model roles, add hosted MCP tools to
the LLM request, or advertise MCP sampling/elicitation that would let a server
spawn unbudgeted model work. Analyst, drafter, and auditor still receive only their
frozen evidence projections. External results enter as untrusted source content,
never as replacement role instructions. The model may propose text; existing
deterministic plan/approval/execution/readback boundaries remain mandatory.

## 8. Commit-by-commit delivery and proof

- **F01/F02:** environment, injection seams, shared method/result types, and
  capability-negative examples. P1 owns dependency/config/shared-file changes.
- **I01:** common REST transport/pagination/error contract and
  `tools/smoke/providers.ts`; no credentials assumed. Test denial, later-page
  failure, repeated cursors, Retry-After, invalid payload, missing receipt, and
  unknown mutation. Preflight mode/manifest must be explicit.
- **I02/I03/I04/I05:** implement each app's routes, scope checks, field-preserving
  normalization, marker lookup, and separate reader interface in its owned files.
  Each commit's tests include contract violations and separate disposable smoke.
- **B02/B03:** consume complete source facts and bind approved exact values;
  source-read calls stay in R01 nodes. Neither policy nor hashing gains a transport.
- **B05/B06/B07:** respectively consume Slack authority, narrow approved effects,
  and independent readback. Approval is checked before every protected write;
  unknown results enter durable reconciliation rather than auto-retry.
- **Q02/Q03:** collect independent observations/provenance and assess the frozen
  manifest. Missing external coverage is unverified, not an empty successful read.
- **R01:** construct and join all modules; prove all four live apps with actual
  readback and human approval in S1, then unchanged IDs/zero excess effects in S2.
  Fake graph proof and provider smoke alone do not close this integration gate.
- **R02:** document the tested account/API versions and sanitized smoke results,
  dependencies, restart behavior, and outstanding access limitations. Never
  announce a working live integration from an unrun setup command.

Use F01's planned application runner only after it is implemented, for example
`npm run test:app -- tests/adapters/github.test.ts`; current monitor commands do
not exercise these adapters. Each provider receipt records account reference,
mode, chosen API/SDK version, tested operations/scopes, actual object IDs privately,
read windows/page completion, output references, commands/exit codes, and all
failed/unrun gates. Published samples remain sanitized. No live smoke was run as
part of this plan update.
