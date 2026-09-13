# Multi-App AI Agent Hackathon: Requirements and Timeline

Research snapshot: September 13, 2026

> Important status: the event site still shows **Register Now**, but the linked
> Google Form currently says it is no longer accepting responses. If the team is
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
   idempotency, retries, timeouts, and rollback/compensation
4. **Evaluation:** scenarios, assertions, metrics, and results
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
- Sign in to the three target apps and prepare API/OAuth credentials.
- Confirm model access, spending limits, and secret handling.
- Assign roles and agree on the single demo scenario.
- Do not prebuild anything the official rules prohibit; the public page does not
  clarify whether pre-existing code or pre-event development is allowed.

### 9:00-9:30 AM: Opening and rule lock

- Record any announced submission URL, rules, sponsor resources, and cutoff.
- Confirm what counts as an external app and whether sandboxed apps count.
- Confirm whether the repository must be public and when code may be written.
- Reduce scope immediately if a requirement conflicts with the planned build.
- Freeze the user story, three required apps, success assertions, and demo owner.

**Exit condition:** a one-sentence pitch, one workflow diagram, and a written
definition of done.

### 9:30-10:10 AM: Walking skeleton

- Create the smallest end-to-end agent path.
- Connect all three required apps with one read or write smoke test each.
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

**Exit condition:** retries cannot duplicate the main side effect, and an
ambiguous request causes no external mutation.

### 12:10-1:00 PM: Build the evaluation harness

- Encode 8-12 scenarios: normal, ambiguous, conflicting, duplicate, denied,
  unavailable dependency, and partial failure.
- Define expected tool calls, final app states, and forbidden side effects.
- Run the suite and save a compact scorecard.

**Exit condition:** evaluations are repeatable with a visible pass/fail result.

### 1:00-2:00 PM: Improve the weakest rubric area

- Fix the failures with the greatest user impact first.
- Ensure the workflow clearly saves time, prevents loss, or improves an outcome.
- Add one technically interesting behavior, such as evidence reconciliation or
  compensation after a partial failure.
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
- [ ] Evaluation results and traces are visible
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