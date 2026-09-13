# Agent spawning and LLM integration

**Status: implementation specification with A01 implemented; live compatibility
remains unrun.** The repository now has the bounded role runtime and model client,
but not the assembled application graph or a successful live-model receipt. This
document assigns the remaining work to the existing commit plan; it does not
claim a live model call or introduce another implementation phase.

**Gemini decision, September 14, 2026:** use the Gemini Developer API free tier
with the stable `gemini-3.8-flash` model for the initial compatibility and demo
runs. Google listed that model's input/output tokens as free of charge when this
decision was checked, but free-tier access and quotas are account-, project-,
region-, and time-dependent. Recheck the official [pricing](https://ai.google.dev/gemini-api/docs/pricing),
[models](https://ai.google.dev/gemini-api/docs/models), and active AI Studio
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) before evidence
capture. There is no request flag that guarantees free service and no automatic
upgrade or fallback to a paid model.

Free-tier prompts and responses may be used by Google to improve its products.
Therefore model-live and integrated demo runs use synthetic, disposable
hackathon data only unless a separate data owner explicitly approves another
tier and handling policy. A key pasted into chat or another non-secret channel
is treated as exposed: rotate it, store the replacement only as the server-side
`GEMINI_API_KEY`, and never copy it into this repository or a receipt.

Read with [workflow](02-agent-workflow.md), [contracts](05-contracts-and-handoffs.md),
[reliability implementation](06-agent-reliability-implementation.md), and
[MCP/API/app integration](08-mcp-api-and-external-app-integration.md).
The [architecture](../promiseguard-architecture.md) remains the stack and scope
reference. All source paths below are planned additions unless already present;
the owning commit must implement them before they can be imported.

## 1. What spawning means in this project

PromiseGuard has three fixed backend role implementations: Incident Evidence
Analyst, Customer Update Drafter, and Blind Semantic Auditor. To **spawn** one is
to invoke that role function from its LangGraph node with a bounded, immutable
input and its own model-call identity. The role uses a separate versioned prompt,
output schema, and context. All wrappers run in the same Node process; the Gemini
Developer API performs the model inference over HTTPS.

There is no operating-system process per agent, dynamically selected workforce,
recursive agent creation, shared conversation, or supervisor LLM. LangGraph owns
the fixed order. The three roles can use the same configured model ID without
sharing messages. Development agents working on branches are unrelated to these
three product roles.

One valid, nonempty selected-set plan revision invokes analyst → drafter →
deterministic checks → auditor, with one logical invocation per role and bounded
transport/schema attempts inside it. A complete empty selection invokes zero
roles. Invalid selection or incomplete evidence also invokes zero roles. If an
earlier role fails or deterministic checks block the proposal, later roles are
not dispatched and the required-stage outcome stays visible.

The initial demo fixture has one eligible commitment and one customer draft.
The product contract also supports multiple selected commitments: one logical
drafter invocation returns bounded entries keyed by exactly the selected IDs,
and one auditor invocation checks the entire proposed set. F02 freezes unique
entry/cardinality and selected-set coverage validation. B03/B06 retain separately
approved task/note/draft effects for each selected commitment. Never drop extra
eligible IDs or add an undocumented per-customer spawning loop; if the complete
set exceeds the frozen input/output capacity, block explicitly before approval.

## 2. Exact call chain and file ownership

1. **F01 — bootstrap:** `src/server/index.ts` validates server configuration;
   `.env.example`, package files, and lockfile document/pin the tested stack.
   It provides a bootstrap seam, not a pretend working graph.
2. **B04 — durable entry:** `src/server/api/runs.ts` accepts an authenticated
   incident command. `src/server/workflow/driver.ts` durably schedules the run
   outside HTTP and invokes/resumes one graph at a time per incident. No LLM call
   belongs in the route or browser.
3. **R01 — composition:** `src/server/composition.ts` instantiates A01's model
   client factory and injects it plus B01 repositories into the three roles.
   `src/server/workflow/graph.ts` defines ordered edges;
   `src/server/workflow/nodes.ts` implements the role call sites below. R01 also
   completes `src/server/index.ts` by connecting the bootstrap to composition.
4. **R01 reads, I02/I03 adapters, B02 policy:** graph read nodes obtain complete
   GitHub/HubSpot snapshots through narrow adapters, then B02 fixes selection.
   Those provider reads are ordinary deterministic backend calls. The models
   receive bounded snapshot projections, not provider clients.
5. **A02 `src/server/agents/analyst/index.ts`:** `analyzeIncident(...)` builds its
   prompt through `analyst/prompt.ts` and calls A01 `invokeRole(...)` with the
   analyst schema and `analyst/validate.ts` validator.
6. **A03 `src/server/agents/drafter/index.ts`:** `draftCustomerUpdate(...)`
   receives the validated analyst artifact and fixed commitment scope; it calls
   the same runtime with its own prompt/schema/validator. B03's deterministic
   proposal checks run before the next role.
7. **A04 `src/server/agents/auditor/index.ts`:** `auditSemantics(...)` receives
   original evidence and proposed text in an independently constructed context.
   It calls A01 with its own prompt/schema/validator. A concern stops review
   progression; required-stage failure stops the run.
8. **A01 `src/server/agents/runtime.ts`:** `invokeRole(...)` loads or claims a
   stable invocation, reserves attempt/budget, persists its start, calls the
   model abstraction, preserves raw responses, validates, and stores immutable
   result/error references. It is the only model retry owner.
9. **A01 `src/server/agents/model.ts`:** `createModelClient(...)` produces the
   injected `dispatchStructured(...)` implementation. This is the only product
  module dispatching Gemini Developer API HTTPS requests.
10. **B03/B05/B06/B07:** after the roles, code freezes exact plan bytes, waits
    for authentic Slack approval, guards/executes the permitted app operations,
    and independently reads them back. None of those stages calls an LLM to
    choose recipients, approve, rewrite an approved draft, or declare success.

The model dependency belongs to A01, role prompts belong to A02–A04, and graph
assembly belongs to R01. A01/A02–A04 must not edit shared schemas, root packages,
storage migrations, API routes, or composition. Request the corresponding
F01/F02/B01/R01 change through that owner.

## 3. Contracts F02 must freeze before implementation

The following names are proposed public exports for `src/shared/agents.ts`,
owned by **F02**. They are not additional competing domain types or a claim that
the current monitor already defines them. Import source references and common
identities from F02's shared domain/event types.

- `AgentRole`: `analyst | drafter | auditor`.
- `AgentInvocationContext`: `runId`, current `runtimeAttemptId`, `planRevision`,
  `role`, stable `roleInvocationKey`, `snapshotBundleRef`, `inputDigest`,
  `promptVersion`, `schemaVersion`, and `modelConfigRef`. The referenced immutable
  model configuration includes the resolved model ID, mode, and budgets but no
  secret. Add the shared evaluation/span fields through the canonical event seam.
- `AnalystInput` → `IncidentAssessment`; `DrafterInput` → `DraftProposal`;
  `AuditorInput` → `AuditFindings`, with paired input/output Zod schemas.
  `DraftProposal` entries cover every selected commitment exactly once; findings
  identify the affected commitment and claim. Reject duplicate, missing, or extra
  commitment IDs. A single-entry fixture exercises the same set contract.
- `AgentCallResult<T>`: a discriminated success/failure result. Success includes
  validated `value`, immutable `outputRef`, `firstOutputRef` when one exists,
  `roleInvocationKey`, and validation evidence. Failure includes a typed reason
  and recorded attempt/artifact references; absent output is never a fake empty
  success. F02 freezes the exact error enum before consumers merge.

Proposed role exports, with dependency details frozen by A01/F02:

```typescript
analyzeIncident(input: AnalystInput, ctx: AgentInvocationContext, deps: AgentDeps)
  : Promise<AgentCallResult<IncidentAssessment>>;
draftCustomerUpdate(input: DrafterInput, ctx: AgentInvocationContext, deps: AgentDeps)
  : Promise<AgentCallResult<DraftProposal>>;
auditSemantics(input: AuditorInput, ctx: AgentInvocationContext, deps: AgentDeps)
  : Promise<AgentCallResult<AuditFindings>>;
```

`AgentDeps` is a server-only injected interface for the A01 runtime/model client,
B01 artifact/event repository, and clock/cancellation controls. It is never
serialized into graph state or exposed in `src/shared/api.ts`. Persist references
in graph state; load restricted source/output content only inside the backend.

### Role-specific input and output

**Analyst:** receives incident fields, referenced commit/deployment and bounded
workflow evidence, source versions, and citation IDs. It returns supported facts,
contradictions, unknowns, and candidate-change assessment. It does not receive
contact addresses, Slack authority, or a desired causal conclusion. Tests must
distinguish correlation from proven cause and valid citation IDs from entailment.

**Drafter:** receives the validated assessment, original supporting facts, fixed
selected commitment facts and permitted next-step constraints. One invocation
returns exact customer-update text and claim-to-source references for every
selected commitment, keyed by its fixed ID. Code retains recipient,
mailbox, owner, subject marker, due-date, and action-type authority; include only
the commitment context needed to draft language. Output fields that try to add
or override those server-owned values are rejected. B03 later binds the exact
accepted text to the immutable plan and `ApprovedContentRef`.

**Auditor:** receives original source projections, all proposed customer-text
entries, claim/source references, and required-content/task constraints. One
invocation returns commitment/claim-specific unsupported, contradictory, or
omitted-content findings and its verdict for the proposed set.
Exclude the analyst assessment narrative, drafter rationale/confidence, previous
messages, prior verdict, and a preferred answer. Its findings can block; they
cannot approve, repair artifacts, or become Q05 human ground truth.

Each role's `prompt.ts` implements a versioned `ChatPromptTemplate` from
`@langchain/core/prompts`; it formats fresh role-specific messages for A01 rather
than passing an accumulated chat transcript. Each prompt treats source text as
untrusted data and separates it from role instructions. Only schema repair for
the same role may add terse validator feedback to another attempt; never share
one role's repair history with another.

## 4. Configuration and the real LLM dispatch

F01 adds these names to `.env.example` and validates them in the backend startup
seam. Examples deliberately contain no key or supposedly tested model ID:

```dotenv
PG_MODEL_MODE=mock
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
GEMINI_MODEL_ANALYST=
GEMINI_MODEL_DRAFTER=
GEMINI_MODEL_AUDITOR=
PG_MODEL_TIMEOUT_MS=30000
PG_MODEL_ROLE_BUDGET_MS=90000
PG_MODEL_MAX_ATTEMPTS=2
PG_MODEL_MAX_OUTPUT_TOKENS=2000
PG_MODEL_MAX_INPUT_CHARS=24000
```

These numbers are proposed development/fixture ceilings, not measured production
settings or a recommendation for a particular model. `PG_MODEL_MAX_ATTEMPTS`
includes the first dispatch and all transport/schema retries combined. The input
character limit bounds the complete serialized role messages; it is not an input
token estimate. Reject oversized context explicitly rather than silently omit
required evidence. F01/A01 must validate the actual schema/context/output-token
combination against the selected model before live use.

In `live` mode require a server-held `GEMINI_API_KEY` and an explicit
`GEMINI_MODEL`; nonempty role overrides select a tested model for that role,
otherwise use the base model. Freeze the resolved IDs and limits in a versioned
`modelConfigRef` per revision. Do not hot-swap a model during retry or resume.
`mock` mode requires an injected Q01 fake and performs zero Gemini requests. A
missing live key, unsupported mode, or unavailable client must fail explicitly;
there is no automatic fallback to mock.

The selected free tier is an evidence mode and operating constraint, not an API
parameter. Do not attach billing or silently switch models after quota exhaustion.
Treat `429 RESOURCE_EXHAUSTED` as `rate_limited`, honor a provider retry delay only
inside the existing role budget, and preserve a failed/exhausted receipt when the
free allocation cannot complete the run.

Keep these settings independent from `PG_ADAPTER_MODE=fake|rest` in the
[external integration guide](08-mcp-api-and-external-app-integration.md). For
example, live models with fake apps establish model behavior against fixtures;
they do not establish live app integration. A mock model with REST adapters still
makes real provider calls and must retain every approval/execution guard.

The A01 implementation uses the official Gemini REST `models.generateContent`
endpoint through the injected server-side `fetch`. Direct REST is deliberate:
it keeps the exact HTTP envelope observable, has no SDK retry layer, and allows
the raw response body to be durably saved before any provider-envelope or role
schema parsing. LangChain remains in use for role prompt templates and LangGraph;
no provider-specific model SDK is required. See the official
[generateContent reference](https://ai.google.dev/api/generate-content) and
[structured-output guide](https://ai.google.dev/gemini-api/docs/structured-output).

Illustrative A01 factory internals; these local helper names are specifications
to implement, not installed library exports:

```typescript
// model.ts: called only by runtime.ts for one recorded modelAttemptId.
// serverSecrets is captured by createModelClient, never read from role input.
async function dispatchStructured(request, onRawResponse) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${request.resolvedModelId}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": serverSecrets.geminiApiKey,
      },
      signal: request.abortSignal,
      redirect: "error",
      body: JSON.stringify({
        systemInstruction: { parts: systemParts(request.messages) },
        contents: userContents(request.messages),
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: request.outputJsonSchema,
          candidateCount: 1,
          maxOutputTokens: request.maxOutputTokens,
        },
        store: false,
      }),
    },
  );
  const raw = {
    body: await response.text(),
    status: response.status,
    requestId: response.headers.get("x-request-id") ?? response.headers.get("x-goog-request-id"),
    retryAfterMs: parseRetryDelay(response),
  };
  await onRawResponse(raw);
  if (!response.ok) throw classifyGeminiError(raw);
  return inspectGeminiResponse(raw);
}
```

The adapter must await the completed non-streaming response and B01 persistence
of its raw body bytes and allowlisted status/request metadata **before parsing
the Gemini envelope or role output**. This preserves error/safety-block/malformed
bodies even if envelope parsing or Zod throws.
Do not record request headers, credentials, or private model reasoning; do not
request reasoning summaries or encrypted reasoning content for these roles. Use a
per-attempt closure so concurrent unrelated runs cannot misattribute responses.
If raw storage fails, stop that stage without a model retry or a claimed saved
artifact; the already-recorded dispatched attempt remains unresolved/error.

The request uses one candidate, `application/json`, the Zod-derived JSON Schema,
and the selected output limit. It omits `tools`, `toolConfig`, grounding, cached
content, and conversation continuation. System text goes only in
`systemInstruction`; each remaining message becomes declared user content. Set
`store: false`, while recognizing that this does not override free-tier product-
improvement terms. Inspect the outgoing request in a transport stub to prove the
endpoint, body, absent tools, header-only key, and one network dispatch.

The actual F01/A01 compatibility smoke must confirm the pinned release's option
names, accepted schema and output-token mapping. Strict schema output still
needs application validation and refusal/incomplete-response handling; it cannot
prove that a factual claim follows from evidence. See official
[Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).

Interpret only one returned candidate. `STOP` with text parts is complete;
`MAX_TOKENS` is incomplete; prompt blocks and candidate finish reasons such as
`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, or `ESCALATION`
are refusals. Missing candidates, non-text/tool parts, unknown finish reasons,
and malformed envelopes are invalid/incomplete. Map `promptTokenCount` to input
usage and `candidatesTokenCount + thoughtsTokenCount` to output usage. Persist
`responseId`, `modelVersion`, finish reason, safety metadata, and the unchanged
body only in restricted evidence; expose no private content in ordinary events.

### Executable compatibility-smoke ownership

**A01 adds `tools/smoke/model.ts`**; F01/P1 owns the registered
`npm run smoke:model` command and its TypeScript runner/build setup. An explicit
live invocation is:

```bash
PG_MODEL_MODE=live npm run smoke:model -- --mode live --role analyst --receipt-dir /absolute/private/promiseguard-model-smoke
```

Supply a real private local receipt directory in place of the example path and
provide the key through server-secret configuration. The runner defaults to mock
mode with zero network calls; live mode requires the explicit switch plus valid
live configuration. `--role analyst|drafter|auditor` selects exactly one schema
per invocation; do not automatically call all roles. A01's existing F02/B01 gates
suffice because the runner builds bounded synthetic noncustomer inputs from F02
examples, without importing A02–A04, R01, or app clients.
The runner owns its small versioned synthetic prompt and F02-based validation
harness; production role prompts/validators are exercised later at R01.

Call the actual A01 `invokeRole` wrapper and model adapter, preserving raw response
before parsing in the B01 restricted receipt store. The smoke defaults to one
dispatch with bounded time/input/output limits. Record its unique smoke identity,
resolved model/config/package/prompt/schema versions, immutable raw output or
refusal/error, parsing/schema outcome, timing, and usage if available. Keep these
receipts outside scored product/quality cohorts. A successful transport and schema
result establishes compatibility for that tested combination only; it does not
evaluate production role prompts, semantic quality, or any app integration.

Missing configuration, refusal, invalid output, timeout, and failed raw storage
produce an explicit failed receipt/nonzero exit when a receipt can be written.
Default tests in `tests/app/agent-runtime.test.ts` use injected clients and prove
zero live requests, selected-schema dispatch, raw-save ordering and redacted
output. A later real run records the exact command, exit status and private
receipt reference; missing access remains unrun. See
[A01's complete runner contract](commits/A01.md#owned-model-compatibility-smoke).

## 5. Invocation, retry, and restart rules

The A01 runtime follows this application-owned sequence:

```text
invokeRole(spec, input, ctx)
  verify input/schema/snapshot completeness and fixed role scope
  load-or-claim roleInvocationKey; compare input and version digests
  if matching validated result exists: return saved artifact, no model call
  if active invocation already owned: yield to its owner, no second dispatch
  if mismatch: require a new reviewed plan revision, no silent cache reuse
  freeze/persist input, config, deadline and attempt budget through B01
  while a permitted attempt remains inside the persisted role/run deadline:
    reserve a unique modelAttemptId and persist attempt.started
    call model.dispatchStructured with a bounded AbortSignal
      raw transport response is durably captured before provider/application parsing
    classify refusal/incomplete/transport/parse outcomes
    apply the role schema and application validator
    persist immutable result or failure; return success only if validated
    if retry eligible: persist retry reason and wake time; consume same budget
  return recorded exhausted/failure result; never fabricate a proposal
```

Use a stable digest of `(runId, planRevision, role)` as `roleInvocationKey`.
Its immutable input digest includes snapshot versions, the fixed selection,
upstream result references when applicable, and prompt/schema/model configuration.
Keep the same key across graph resumes; each actual graph invocation has its own
`runtimeAttemptId`, each network dispatch a new `modelAttemptId`, and each role
attempt retains its parent stage/span. If using `logicalCallId`, bind it to this
logical invocation rather than generate another identity on every retry.

B01 must provide the uniqueness/claim and immutable artifact/result repository
seams before A01 merges. A completed result committed before a graph checkpoint
is reused after restart. A dispatched attempt whose outcome was never persisted
remains an interrupted/unknown model attempt. Do not claim the provider was never
called or guarantee exactly-once model billing: an allowed replacement dispatch
has a distinct recorded ID and consumes the remaining original budget. Never
re-dispatch an exhausted invocation automatically.

Persist absolute deadline, attempt count, and scheduled retry time. Use a
monotonic clock for active elapsed duration; reboot cannot reset the configured
budget. Clamp the per-dispatch timeout to remaining role and run time and abort
on shutdown/cancellation. Rate-limit/transient transport failures and bounded
schema-format repair share the single attempt budget. Authentication, unsupported
configuration/schema, refusals, storage failure, and semantic/policy failures do
not trigger blind retry. Honor a server retry delay only when it fits the budget.
Gemini documents `429` rate/quota exhaustion and `5xx` transient failures in its
[API errors](https://ai.google.dev/gemini-api/docs/api-errors); daily quota
exhaustion must not enter a rapid repair loop.

Keep the first returned output, including an invalid one, byte-for-byte. Later
outputs are linked corrections, not replacements. A timeout with no response has
an attempt record and no invented output. A changed source set or human text edit
requires a new plan/content revision and fresh approval; it cannot overwrite
the original quality record or reopen an unlimited model repair loop.

Ordinary Slack wait/resume reuses all completed role results and invokes no model.
If freshness checks require a new review revision and effect-ledger rules permit
it, R01 refetches evidence and creates that revision before rerunning the roles.
An incompatible applied/uncertain effect follows the existing `failed_partial`
reconciliation path. Changing the plan must not create a new effect namespace to
evade existing protected effects.

## 6. Commit-by-commit delivery and acceptance

- **[F01](commits/F01.md):** pin the compatible graph/prompt dependencies; implement
  configuration validation and application test runner. Prove mock boot requires
  no key and invalid live configuration fails before dispatch. Maintain A01's
  registered `smoke:model` script through the same owned runner/dependency seam.
  Do not commit keys.
- **[F02](commits/F02.md):** freeze the role, invocation, result, error, artifact,
  and event contracts above with accepted/rejected examples and reuse rules.
- **[B01](commits/B01.md):** provide unique role claims, immutable source/raw/result
  persistence, append-only attempt history, and durable budgets for A01.
- **[B04](commits/B04.md):** schedule one graph invocation per incident and resume
  with a stable thread/run identity; pass validated services through injection.
- **[A01](commits/A01.md):** implement `runtime.ts`, the `model.ts` HTTPS call
  site and owned `tools/smoke/model.ts`. Test raw-before-parser ordering, exact
  dispatch counts, bounded retries,
  refusal/exhaustion, crash/reuse, redaction, and explicit mock/live separation.
  Record one actual structured-output compatibility smoke separately from mocks.
- **[A02](commits/A02.md):** implement `analyzeIncident`, scoped prompt, mechanical
  validator, and weak/contradictory/injected-source cases. Hand R01 the validated
  `IncidentAssessment` and immutable first-output references.
- **[A03](commits/A03.md):** implement `draftCustomerUpdate`, fixed-scope prompt,
  validator, and invented-ETA/identity-change/omitted-uncertainty cases. Hand B03
  exact per-commitment text/source references; reject missing/duplicate/extra
  selected entries. Do not invoke Gmail here.
- **[A04](commits/A04.md):** implement `auditSemantics`, independent projection,
  validator, and context-leakage/missed-defect/false-block cases. A required
  unavailable auditor never becomes a clear verdict.
- **[B03](commits/B03.md), [R01](commits/R01.md):** validate/freeze and wire the
  actual three-role chain. Assert `analyst, drafter, auditor` dispatch order for
  a valid initial revision; zero calls for no-affected/invalid selection; zero
  additional calls on approval resume or completed replay. Earlier failures
  prevent later calls, and first outputs survive graph restarts.
- **[Q01](commits/Q01.md), [Q04](commits/Q04.md):** supply injected mock clients and
  stateful failure scenarios for the real graph. A fake result is labeled as such;
  do not put a production "fallback result" into a role implementation.
- **[Q03](commits/Q03.md), [Q05](commits/Q05.md), [Q06](commits/Q06.md):** assess
  actual model-attempt telemetry, independently label original outputs when
  available, and optionally export sanitized traces. Export is not another
  model call and cannot gate a successful recorded local result.
- **[U02](commits/U02.md), [U03](commits/U03.md), [R02](commits/R02.md):** display
  backend stage state, immutable evidence references, failure/unverified status,
  and model/provider modes. Release receipts list real model IDs/transport versions,
  calls and unrun gates; browser code never holds the Gemini key.

Preserve the existing hard merge prerequisites in the individual commit briefs.
These details explain implementation seams; they do not add a live-model gate
to every role's unit-test merge or claim module fixtures prove semantic quality.
After F01 supplies the runner, use each A-commit's named application test file;
R01 supplies the integrated scenario proof and Q05 the independent source-based
labels. Keep mock, actual-model, and live-app evidence separate throughout.
