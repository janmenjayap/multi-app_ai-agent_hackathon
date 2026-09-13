# Multi-App AI Agent Hackathon: Requirements and Timeline

Research snapshot: September 13, 2026. The implementation update below does not
recheck event announcements or registration status.

**Using this document for PromiseGuard:** the official requirements below are
the event baseline. The selected project uses **GitHub + HubSpot + Slack + Gmail**;
its [demo and reliability contract](demo-scenarios-and-reliability.md) supplies
the canonical scenarios, metrics, evidence requirements, and remaining-time plan.
The application is not implemented. At the September 13 planning baseline only
the offline checker was runnable. **September 14 update (IST):** a standalone
Node 24/TypeScript/SQLite [monitor](../tools/monitoring/README.md) now assesses
supplied traces, snapshots, and labels. Its synthetic demonstrations are not
working-app results; F01/F02 and Q02–Q05 remain partial. The full-day schedule here
is a planning template, not a fresh 390-minute budget. Older refund/Linear ideas
are historical alternatives.

**Reliability delivery plan:** [the detailed implementation sequence](implementation-plan/06-agent-reliability-implementation.md)
and updated commit briefs turn the audit gaps into P0 work: real traces and
runtime controls, independent expected-versus-actual provider state, and original
AI outputs with human labels. This is a documentation update, not evidence that
the live workflow or its evaluation has been implemented.

> Registration observation at the September 13 research snapshot: the event site
> showed **Register Now**, but the linked Google Form was no longer accepting
> responses. Verify current participant instructions. If the team is
> not already registered, confirm admission with the organizers immediately.
> Do not assume that a project submission alone grants entry.

## 1. Event at a Glance

- **Event:** Multi-App AI Agent Hackathon
- **Format:** Virtual
- **Date:** Sunday, September 13, 2026
- **Official timezone:** Pacific Time
- **Core challenge:** Build one useful, multi-step AI agent that takes action
  across at least three external apps, and show evidence that it works.
- **Team size:** One to four people
- **Cash prizes:** $10,000 first place, $4,000 second place, $1,000 third place
- **Additional prize:** Every top-three team receives guaranteed interviews
  with Arga Labs or Lemma AI.

On September 13, Pacific Time is Pacific Daylight Time (UTC-7). Use the
organizers' displayed Pacific Time schedule as the source of truth if a calendar
invite or event communication differs.

## 2. Official Build Requirements

The public event page explicitly requires all of the following:

1. Build **one useful AI agent**.
2. The agent must execute a **multi-step** workflow.
3. It must **connect to at least three external apps**.
4. It must **take action** across those apps; a read-only chat or summary is a
   weak interpretation of the brief.
5. The team must **show how it knows the agent works**.
6. Teams may contain **one to four people**.

The phrase "show how you know it works" is central, not optional polish:
reliability and evaluation account for 25% of the score.

### Practical acceptance test

Before polishing the interface, verify that one user request can complete this
minimum observable chain:

1. Receive a realistic trigger or goal.
2. Read relevant state from an external app.
3. reason over that state and choose the next action.
4. Write or take an action in a second external app.
5. Write or take an action in a third external app.
6. Verify the resulting state rather than trusting a tool's success message.
7. Produce a trace or result report showing each step, decision, and side effect.

Aim for four integrated apps if the fourth is easy, but make the first three
genuinely reliable. Three working integrations beat six decorative logos.

## 3. Required Submission Package

The public page lists three deliverables:

- A **working project or repository**
- A **two-minute demo**
- A **short system and reliability brief**

No public format, word limit, repository visibility requirement, demo hosting
platform, or submission portal is currently specified. Capture those details
during the opening session or from accepted-participant communications.

### Recommended repository contents

These are recommendations, not published rules:

- A README with the problem, workflow, app integrations, setup, and demo path
- A one-command local start procedure
- A sample environment file with no secrets
- Seeded demo data or a reproducible sandbox scenario
- An evaluation command and machine-readable results
- An architecture diagram
- A fallback recording in case the live demo fails
- The short system and reliability brief, preferably in the repository

### Recommended reliability brief outline

Keep the brief to roughly one page unless the organizers specify otherwise:

1. **System:** trigger, planner/orchestrator, tools, state store, and user surface
2. **External apps:** what is read and what is changed in each app
3. **Reliability controls:** schema validation, permissions, approvals,
   idempotency, bounded retries/timeouts, and partial-failure reconciliation.
   State which effects can be repaired or compensated; PromiseGuard preserves
   applied work and escalates incompatible changes rather than promising rollback.
4. **Evaluation:** frozen release/fixtures, expected outcomes, raw passed/attempted
   counts by live/simulated/checker mode, first-proposal semantic quality, and
   failed/unrun cases. Approval or a corrected final draft does not establish
   correctness of the model's original output.
   Include suite coverage for not-run cases, evidence provenance/completeness,
   and completion claims classified with time-linked observations. Distinguish
   premature success, contradicted outcomes, uncertain timing, and later edits.
5. **Known limits:** unsupported requests and what safely happens on ambiguity

## 4. Judging Rubric

### Technical execution: 30%

Demonstrate a real end-to-end workflow, correct tool selection, meaningful
state transfer between apps, sound architecture, and observable side effects.
Avoid integrations that are only shown as disconnected API calls.

### Reliability and evaluation: 25%

Show repeatable tests and failure handling. Strong evidence includes:

- A scenario suite with happy paths and adversarial cases
- State assertions in every connected app
- A trace linking the user's goal to tool calls and final outcomes
- Protection against duplicate actions
- Explicit handling of partial failure, timeout, and ambiguous identity
- Human approval before high-impact or external-facing actions
- A visible scorecard: pass rate, forbidden side effects, and latency

These are evidence recommendations, not claims that a demo automatically proves
them. Show source-grounded model decisions as well as system controls. Freeze
expected artifacts independently of the worker; test missing/incorrect outcomes,
invalid approvals, incomplete reads, concurrent replay, and safe partial stops.
An LLM auditor is a supplementary check; independently labeled drafts and actual
provider state remain necessary. Report targets separately from observations.

### Usefulness: 20%

Choose an expensive, frequent, or high-risk workflow with a clear user. State
the before-and-after result in concrete terms such as time saved, errors
prevented, revenue protected, or response time reduced.

### Originality: 15%

The agent should do more than summarize, search, or relay messages. A compelling
entry closes a cross-app loop, handles conflicting evidence, or verifies that
the intended real-world outcome occurred.

### Demo clarity: 10%

One scenario, one user goal, one visible chain of actions, and one proof screen
will score better than a tour of every feature.

## 5. Official Event Schedule

All times below are the event site's published Pacific Time schedule.

- **9:00 AM:** Opening
- **9:30 AM-4:00 PM:** Build
- **4:00-4:40 PM:** Judging and selection
- **4:40-5:00 PM:** Awards

The official build window is 6 hours 30 minutes, or 390 minutes.

## 6. Recommended Event-Day Timeline

This plan works backward from a hard 4:00 PM deadline and reserves the final 40
minutes for validation, recording, documentation, and submission. Adjust it if
the opening announces different rules.

### Before 9:00 AM: Access and logistics only

- Confirm that every team member can enter the event workspace and call.
- Verify registration/admission status.
- Sign in to the target apps and prepare API/OAuth credentials; PromiseGuard
  requires all four: GitHub, HubSpot, Slack and Gmail.
- Confirm model access, spending limits, and secret handling.
- Assign roles and agree on the single demo scenario.
- Do not prebuild anything the official rules prohibit; the public page does not
  clarify whether pre-existing code or pre-event development is allowed.

### PromiseGuard integration prerequisites and commit gates

The following are project implementation decisions, not additional organizer
requirements. Use the [LLM/agent guide](implementation-plan/07-agent-spawning-and-llm-integration.md)
and [MCP/API/app guide](implementation-plan/08-mcp-api-and-external-app-integration.md)
with the existing [commit order](implementation-plan/04-commit-plan.md). These
gates consume the actual remaining time; they do not restart the event clock.

1. **F01/F02 — lock access and contracts:** record the selected model and its
   server-side secret source, role schemas, package versions, bounded budgets,
   and four disposable provider scopes/IDs. Verify repo access, HubSpot fixture
   fields/associations, Slack posting and genuine human thread-reply reads, and
   Gmail OAuth draft access. Keep secrets outside prompts/browser/config examples.
   Freeze model/provider provenance separately from public evidence-mode labels.
2. **A01 and I01–I05 — compatibility/access gate:** obtain real structured-output
   smoke receipts for analyst/drafter/auditor schemas and independent provider
   read/write/readback receipts. REST is required and MCP is disabled for the MVP;
   an optional extension qualifies reads first using a selected server, approved
   exact tool map and equivalent contract tests. Later protected-write mappings
   require explicit adapter conformance and every existing workflow guard.
   Installing an assistant connector is not backend authentication. Missing
   access is an unrun/failed gate, not grounds to relabel a fake as a live app.
3. **B04, A02–A04 and R01 — executable role gate:** the persisted driver schedules
   the graph, which invokes analyst → drafter → checks → auditor through A01's
   shared recorded model wrapper. Use three bounded backend roles; no dynamic
   process spawning or model-selected app tools. Test fake graph wiring before
   scoped model-live execution and preserve first results and failures.
4. **B02/B05/B06/B07 and R01 — integrated app gate:** wire GitHub/HubSpot reads in
   R01's source-read nodes, B02's pure validation/selection, authentic Slack
   review/approval, serial HubSpot task → note → Gmail draft →
   GitHub comment writes, fresh destination readbacks and verified Slack summary.
   Q02 independently collects provider state. Do not record a four-app product
   demo until the same-run evidence supports the joined workflow.
5. **Q04/Q05/R02 — release proof gate:** run frozen scenario/fault coverage and
   actual original-output human review. Report fake-only, model-live, provider-
   live and combined-live observations separately, along with versions, failures
   and not-run cases. Reserve time for evidence, recording and submission before
   optional MCP transport, remote tracing, hosting or UI polish.

P1 owns foundation/contracts and graph composition; P2 owns integrations and
provider access; P3 owns model wrapper and roles; P4 owns independent fixtures,
collection, evaluation and demo evidence. These are the existing plan owners;
development parallelism does not permit parallel protected writes at runtime.

### 9:00-9:30 AM: Opening and rule lock

- Record any announced submission URL, rules, sponsor resources, and cutoff.
- Confirm what counts as an external app and whether sandboxed apps count.
- Confirm whether the repository must be public and when code may be written.
- Reduce scope immediately if a requirement conflicts with the planned build.
- Freeze the user story, required apps, success assertions, and demo owner;
  PromiseGuard's accepted scope includes four apps and three bounded model roles.

**Exit condition:** a one-sentence pitch, one workflow diagram, and a written
definition of done.

### 9:30-10:10 AM: Walking skeleton

- Create the smallest end-to-end agent path.
- Connect the required apps with scoped read/write/readback smokes; for
  PromiseGuard run I01–I05 against all four and A01's separate model smoke.
- Add a run ID and structured event log from the beginning.
- Seed one deterministic demo scenario.

**Exit condition:** the app starts locally and every integration authenticates.

### 10:10-11:20 AM: Complete the happy path

- Implement goal parsing and structured tool inputs.
- Pass real state from app one into decisions and actions in apps two and three.
- Re-read destination state to verify side effects.
- Render a simple run timeline showing decisions and outcomes.

**Exit condition:** one user request reliably completes the whole workflow.

### 11:20 AM-12:10 PM: Make failure safe

- Add timeouts, bounded retries, and useful failure messages.
- Add idempotency keys or duplicate-action detection.
- Require approval for irreversible, financial, or customer-facing actions.
- Stop safely when identity, authorization, or source data is ambiguous.

**Exit condition:** replay/concurrency fixtures show no duplicate main effect,
unknown write outcomes reconcile or stop safely, and ambiguity causes no
protected mutation. PromiseGuard may post an allowlisted Slack clarification;
that is a coordination write and must still be logged.

### 12:10-1:00 PM: Build the evaluation harness

- For PromiseGuard, use the canonical 18-family suite; its full target is 42
  baseline/repetition attempts plus declared variants/repair legs and at least
  five live scenarios. A smaller initial checkpoint leaves the remaining census
  explicitly not run; do not replace the canonical suite with an 8–12-case count.
- Freeze expected facts, logical effects, tool/process predicates, final app
  states, forbidden effects, evidence windows, and deadlines before execution.
- Run the actual graph; capture independent S0/S1 and claim-related provider
  observations plus original model outputs and human labels. Save M1–M7 and
  critical counts by mode/version with failed, unverified, and unrun entries.

**Exit condition:** executions are repeatable and their verdicts are supported by
independent evidence. Checker tests and generated human-label fixtures remain
separately labeled. Completion claims require corroborated evidence; a zero
legacy premature-claim counter is insufficient. This schedule remains a planning
template, not a claim that the full evaluation fits this single time block.

### 1:00-2:00 PM: Improve the weakest rubric area

- Fix the failures with the greatest user impact first.
- Ensure the workflow clearly saves time, prevents loss, or improves an outcome.
- Add one technically interesting behavior, such as evidence reconciliation or
  verified resumption after a partial failure. Demonstrate compensation only if
  explicitly supported; never imply every remote effect can be undone.
- Remove any feature that does not strengthen the two-minute story.

**Exit condition:** all critical scenarios pass and the value proposition is
understandable in one sentence.

### 2:00-2:40 PM: Demo surface and evidence

- Make the initial state, requested goal, agent steps, approvals, and final state
  readable on one screen or in a short sequence.
- Prepare before/after views in all three apps.
- Display evaluation results and one prevented unsafe action.
- Remove debug noise and redact secrets or personal data.

**Exit condition:** a teammate unfamiliar with the implementation can follow
the demo without narration.

### 2:40-3:10 PM: Reliability and submission brief

- Finish the architecture and reliability summary.
- Document setup and the exact demo command.
- Record known limitations honestly.
- Prepare links and permissions for every submission artifact.

**Exit condition:** a judge can run or inspect the project without asking the
team for missing information.

### 3:10-3:35 PM: Rehearse and record

- Run the two-minute script twice with a timer.
- Record a clean fallback demo.
- Check audio, text size, browser zoom, notifications, and secret redaction.
- Freeze features after the recording succeeds.

**Exit condition:** live and recorded demos both fit within two minutes.

### 3:35-3:50 PM: Final regression

- Start from a clean environment and execute the golden path once.
- Run the evaluation suite.
- Open every submitted link in a private browser window.
- Confirm repository access and video playback.

### 3:50-4:00 PM: Submit with buffer

- Submit all artifacts before the deadline.
- Save submission confirmation.
- Do not spend this window adding features.

## 7. Two-Minute Demo Script

- **0:00-0:15 - Problem:** identify the user and costly workflow in one sentence.
- **0:15-0:30 - Goal:** issue one realistic request and show initial app state.
- **0:30-1:15 - Action:** show the agent reason and act across at least three apps.
- **1:15-1:35 - Proof:** show verified final states and the evaluation scorecard.
- **1:35-1:50 - Safety:** show one ambiguous or dangerous action being blocked or
  routed for approval.
- **1:50-2:00 - Value:** state the measurable result and close on the final state.

## 8. Team Allocation

For a four-person team:

- **Agent lead:** orchestration, prompts, structured outputs, and state
- **Integration lead:** authentication and app adapters
- **Reliability lead:** traces, eval scenarios, assertions, and failure handling
- **Product/demo lead:** interface, seed data, brief, recording, and submission

For a solo or two-person team, keep the same responsibilities but reduce the
workflow to three apps and one golden path. Do not reduce evaluation coverage to
make room for a broad interface.
For the selected PromiseGuard submission, four apps are part of the promised
outcome. Reducing to three requires an explicit scope change, revised acceptance
criteria, and reevaluation; simply dropping Gmail does not pass its golden path.

## 9. Publicly Unspecified Items to Confirm

The public pages reviewed do **not** currently specify the following:

- Registration deadline, waitlist, or late-entry process
- Eligibility restrictions such as age, country, employment, or affiliation
- Whether all members must register separately
- Rules for forming or changing teams
- Whether work must begin at 9:30 AM or may use pre-existing code
- Required model, framework, language, cloud, or sponsor technology
- The exact definition of an "external app"
- Whether mocked, local, or sandbox apps count toward the minimum of three
- Whether every integration must both read and write
- Submission URL, submission cutoff mechanics, or late-submission policy
- Repository visibility, licensing, IP ownership, or open-source requirements
- Demo format: live, recorded, uploaded, or linked
- Reliability brief format or length
- Internet/API credits, sponsor accounts, and permitted paid services
- Use of AI coding assistants, templates, or third-party code
- Data privacy, security, and production-account restrictions
- Judging tie-breaks, dispute process, prize eligibility, and tax handling

The event page says official rules are available before registration, but no
public rules link was exposed on the pages reviewed. Treat accepted-participant
email, opening-session instructions, and the official rules as controlling if
they differ from this document.

## 10. Final Submission Checklist

- [ ] Team has one to four members and confirmed admission
- [ ] One useful, multi-step agent is working
- [ ] At least three external apps participate in the actual workflow
- [ ] The agent takes visible action, not only reads or summarizes
- [ ] Final state is verified in each destination app
- [ ] Happy path succeeds from a clean start
- [ ] Duplicate, ambiguous, denied, and partial-failure cases are tested
- [ ] Model grounding, incomplete reads, approval bypass, and concurrent replay
      are evaluated against fixed expectations
- [ ] PromiseGuard's three role calls, four app adapters and exact runtime call
      sites are documented; F01/A01 and I01–I05 compatibility/access gates passed
- [ ] Same-run model-live plus provider-live proof supports any integrated live
      claim; MCP, if enabled, has an approved tested tool map and runtime auth
- [ ] Evaluation results and traces are visible
- [ ] Actual counts, first-proposal quality, failed/unrun cases, and evidence mode
      are disclosed; synthetic checker passes are not labeled agent success
- [ ] Working project/repository link opens for a logged-out reviewer
- [ ] Two-minute demo plays and stays under the limit
- [ ] Short system and reliability brief is included
- [ ] Secrets and personal data are absent from code, logs, and video
- [ ] Submission is completed and confirmed before 4:00 PM Pacific Time

## Sources

- [Official hackathon page](https://multiappagenthackathon.com/)
- [Official judging panel](https://multiappagenthackathon.com/judges/)
- [Registration form](https://docs.google.com/forms/d/e/1FAIpQLSekImCUe5qeXwYA0kFSFrJZ07TneLSJcWplcQaHhshpyQUj-A/viewform)

All factual event requirements above were checked against the public pages on
September 13, 2026. Recommendations and interpretations are labeled as such.
