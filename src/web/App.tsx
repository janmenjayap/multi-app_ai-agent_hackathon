import { lazy, Suspense, useRef, useState } from 'react';
import { IncidentInput } from './components/IncidentInput.js';
import { StatusBand } from './components/StatusBand.js';
import { EvidencePanel } from './components/EvidencePanel.js';
import { PlanPanel } from './components/PlanPanel.js';
import { RunTimeline } from './components/RunTimeline.js';
import { EffectsPanel } from './components/EffectsPanel.js';
import type { ConsoleFixture } from './fixtures/demo.js';
import type { RunApiClient } from './api/client.js';
import { useRun } from './hooks/useRun.js';
import { RunControls } from './components/RunControls.js';
import { EvaluationSummary } from './components/EvaluationSummary.js';
import './styles.css';

const CONNECTION_LABELS: Record<ConsoleFixture['connection'], string> = {
  synthetic: '◇ Local preview', offline: '△ Offline · stale data', reconnecting: '◷ Reconnecting', session_expired: '⊘ Session expired',
};

function FixtureConsole({ initialFixtureId, fixtures, defaultFixtureId }: { initialFixtureId: string; fixtures: readonly ConsoleFixture[]; defaultFixtureId: string }) {
  const [fixtureId, setFixtureId] = useState(initialFixtureId);
  const [copyStatus, setCopyStatus] = useState('Copy run ID');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fixture = fixtures.find(item => item.id === fixtureId) ?? fixtures[0];
  const defaultFixture = fixtures.find(item => item.id === defaultFixtureId)!;
  const run = fixture.run;
  const allowedIncidentUrl = defaultFixture.run!.incident.url;

  function reopen() {
    setFixtureId(defaultFixtureId);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function copyRunId() {
    if (!run) return;
    try { await navigator.clipboard.writeText(run.runId); setCopyStatus('Copied'); }
    catch { setCopyStatus('Copy unavailable'); }
  }

  return <>
    <a className="skip-link" href="#console-main">Skip to incident</a>
    <header className="app-header">
      <a className="wordmark" href="#console-main"><span className="brand-mark" aria-hidden="true">P</span>PromiseGuard</a>
      <span className="header-divider" aria-hidden="true" />
      <span className="header-caption">Operator console</span>
      <span className="environment-label">◇ Synthetic · mock models · fake providers</span>
      <span className="connection-label" aria-live="polite">{CONNECTION_LABELS[fixture.connection]}</span>
    </header>
    <main id="console-main" className="console-shell">
      <section className="preview-toolbar" aria-label="Synthetic fixture selector">
        <div><strong>◇ Synthetic preview</strong><p>No models or external apps have been called. All records, approvals and assessments are illustrative.</p></div>
        <div className="fixture-picker"><label htmlFor="fixture-select">Preview scenario</label>
          <select id="fixture-select" value={fixture.id} onChange={event => { setFixtureId(event.target.value); setCopyStatus('Copy run ID'); }}>
            {fixtures.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></div>
      </section>
      <div className="run-heading-row"><div><p className="eyebrow">Incident workspace</p>
        <h1 ref={headingRef} tabIndex={-1}>{run?.incident.title ?? 'Review an incident. Protect a promise.'}</h1></div>
        {run && <div className="run-identity"><span>Run <code>{run.runId}</code></span><button type="button" className="quiet-button" onClick={copyRunId}>{copyStatus}</button><span className="muted">Revision {run.revision} · {run.incident.environment}</span></div>}
      </div>
      <IncidentInput key={fixture.id} incidentUrl={run?.incident.url ?? allowedIncidentUrl} allowedIncidentUrl={allowedIncidentUrl}
        disabled={fixture.connection !== 'synthetic'} error={fixture.error} onSubmit={reopen} />
      {fixture.notice && <p className="notice fixture-notice">△ {fixture.notice}</p>}
      {run ? <>
        <StatusBand run={run} />
        <RunTimeline run={run} trace={fixture.trace} />
        <div className="review-workspace"><EvidencePanel run={run} /><PlanPanel run={run} /></div>
        <EffectsPanel run={run} />
        <EvaluationSummary run={run} synthetic />
      </> : <section className="empty-workspace"><span className="empty-mark" aria-hidden="true">↗</span><h2>No run selected</h2><p>Open the synthetic incident to review its selected commitments, exact draft and Slack review state.</p></section>}
      <footer className="console-footer"><span>PromiseGuard · GitHub / HubSpot / Slack / Gmail</span><span>Fixture console U01 · conventions 1.2 · API schema v2</span></footer>
    </main>
  </>;
}


let previewModule: typeof import('./fixtures/demo.js') | undefined;
/** Explicit preview entry only; normal backend loading/errors never import fixture data. */
export async function loadConsolePreview() {
  previewModule ??= await import('./fixtures/demo.js');
  return previewModule;
}
function LoadedPreview({ initialFixtureId }: { initialFixtureId?: string }) {
  const source = previewModule!;
  return <FixtureConsole initialFixtureId={initialFixtureId ?? source.DEFAULT_FIXTURE_ID}
    fixtures={source.DEMO_FIXTURES} defaultFixtureId={source.DEFAULT_FIXTURE_ID} />;
}
const LazyPreview = lazy(async () => { await loadConsolePreview(); return { default: LoadedPreview }; });

const LIVE_CONNECTION_LABELS = {
  connected: '✓ Connected', reconnecting: '◷ Reconnecting', offline: '△ Offline · stale data',
  session_expired: '⊘ Session expired', unauthorized: '⊘ Access denied',
};

function LiveConsole({ client }: { client?: RunApiClient }) {
  const state = useRun({ client });
  const { run } = state;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copyStatus, setCopyStatus] = useState('Copy run ID');
  async function copyRunId() {
    if (!run) return;
    try { await navigator.clipboard.writeText(run.runId); setCopyStatus('Copied'); }
    catch { setCopyStatus('Copy unavailable'); }
  }
  async function start(incidentUrl: string) {
    await state.start(incidentUrl);
    setCopyStatus('Copy run ID');
    // Failed commands keep focus on the error supplied by RunControls.
    requestAnimationFrame(() => {
      if (!document.querySelector('[role="alert"]')) headingRef.current?.focus();
    });
  }
  return <>
    <a className="skip-link" href="#console-main">Skip to incident</a>
    <header className="app-header">
      <a className="wordmark" href="#console-main"><span className="brand-mark" aria-hidden="true">P</span>PromiseGuard</a>
      <span className="header-divider" aria-hidden="true" />
      <span className="header-caption">Operator console</span>
      <span className="environment-label">{run
        ? `${run.configuration.evidenceMode.replaceAll('_', ' ')} · ${run.configuration.modelMode} models · ${run.configuration.providerMode} providers`
        : 'Configuration unavailable until a run is loaded'}</span>
      <span className="connection-label" aria-live="polite">{LIVE_CONNECTION_LABELS[state.connection]}</span>
    </header>
    <main id="console-main" className="console-shell">
      <div className="run-heading-row"><div><p className="eyebrow">Incident workspace</p>
        <h1 ref={headingRef} tabIndex={-1}>{run?.incident.title ?? 'Review an incident. Protect a promise.'}</h1></div>
        {run && <div className="run-identity"><span>Run <code>{run.runId}</code></span>
          <button type="button" className="quiet-button" onClick={copyRunId}>{copyStatus}</button>
          <span className="muted">Revision {run.revision} · {run.incident.environment}</span></div>}
      </div>
      <RunControls run={run} pending={state.pending} connection={state.connection} error={state.error}
        commandResult={state.commandResult} onStart={start} onReconcile={state.reconcile} onReconnect={state.reconnect} />
      {state.connection !== 'connected' && run && <p className="notice">Last-known run state · updated {run.updatedAt}. Backend work continues independently of this browser.</p>}
      {run ? <>
        <StatusBand run={run} />
        <RunTimeline run={run} trace={state.trace ?? undefined} />
        <div className="review-workspace"><EvidencePanel run={run} /><PlanPanel run={run} /></div>
        <EffectsPanel run={run} />
        <EvaluationSummary run={run} />
        <details className="report-details"><summary>Persisted run events</summary>
          {state.events.length ? <ol>{state.events.map(event => <li key={event.eventId}>
            <time dateTime={event.at}>{event.at}</time> · {event.stageId} · {event.kind} · <code>{event.eventId}</code>
            {event.reference?.href && <a className="source-link" href={event.reference.href}>{event.reference.label}</a>}
          </li>)}</ol> : <p className="muted">No events loaded for this browser cursor.</p>}
          <p className="muted">Events show recorded activity; independent assessments determine whether claims are supported.</p>
        </details>
      </> : <section className="empty-workspace"><span className="empty-mark" aria-hidden="true">↗</span>
        <h2>No run selected</h2><p>Enter a GitHub incident URL to start or reopen its persisted workflow. Human review takes place in Slack.</p></section>}
      <footer className="console-footer"><span>PromiseGuard · GitHub / HubSpot / Slack / Gmail</span>
        <span>Durable console U02 · conventions 1.2 · API schema v2</span></footer>
    </main>
  </>;
}

export function App({ initialFixtureId, client }: { initialFixtureId?: string; client?: RunApiClient } = {}) {
  const preview = initialFixtureId !== undefined || new URLSearchParams(window.location.search).has('preview');
  if (preview) return previewModule ? <LoadedPreview initialFixtureId={initialFixtureId} />
    : <Suspense fallback={<p role="status">Loading explicit synthetic preview…</p>}><LazyPreview initialFixtureId={initialFixtureId} /></Suspense>;
  return <LiveConsole client={client} />;
}
