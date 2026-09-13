import type { RedactedReference, RunView, StageView, TraceAttemptView, TraceView } from '../../shared/api.js';
import { PIPELINE_STAGE_IDS } from '../../shared/domain.js';

const STAGE_LABELS: Record<StageView['stageId'], string> = {
  ingest: 'Ingest', select: 'Select', analyst: 'Analyze', drafter: 'Draft', auditor: 'Audit',
  approval: 'Approve', execute: 'Execute', verify: 'Verify', assess: 'Assess',
};

const ROLE_LABELS = {
  analyst: 'Evidence Analyst', drafter: 'Customer Update Drafter', auditor: 'Blind Semantic Auditor',
} as const;

const APP_LABELS = { github: 'GitHub', hubspot: 'HubSpot', gmail: 'Gmail', slack: 'Slack' } as const;

const STAGE_STATES: Record<StageView['status'], { label: string; icon: string }> = {
  not_started: { label: 'Not started', icon: '○' }, queued: { label: 'Queued', icon: '◷' },
  running: { label: 'Running', icon: '↻' }, waiting: { label: 'Waiting', icon: '◷' },
  succeeded: { label: 'Succeeded', icon: '✓' }, failed: { label: 'Failed', icon: '×' },
  blocked: { label: 'Blocked', icon: '⊘' }, skipped: { label: 'Skipped', icon: '—' },
  unknown: { label: 'Unknown', icon: '?' },
};

function Reference({ reference }: { reference: RedactedReference | null }) {
  if (!reference) return <span className="muted">Unavailable</span>;
  return reference.availability === 'available' && reference.href
    ? <a className="source-link" href={reference.href}>{reference.label}</a>
    : <span className="muted">{reference.label} · {reference.availability}</span>;
}

function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{value}</time> : <span className="muted">Unavailable</span>;
}

function AttemptDetails({ attempt }: { attempt: TraceAttemptView }) {
  return (
    <details>
      <summary>
        {attempt.type === 'model' ? `Model attempt · ${attempt.outcome}` : `${APP_LABELS[attempt.app]} · ${attempt.operation}`}
      </summary>
      <dl className="detail-list">
        <dt>Runtime attempt ID</dt><dd>{attempt.runtimeAttemptId}</dd>
        <dt>Logical call ID</dt><dd>{attempt.logicalCallId}</dd>
        <dt>Started</dt><dd><Timestamp value={attempt.startedAt} /></dd>
        <dt>Finished</dt><dd><Timestamp value={attempt.finishedAt} /></dd>
        <dt>Latency</dt><dd>{attempt.latencyMs === null ? 'Unavailable' : `${attempt.latencyMs} ms`}</dd>
        {attempt.type === 'model' ? <>
          <dt>Role</dt><dd>{ROLE_LABELS[attempt.role]}</dd>
          <dt>Model attempt ID</dt><dd>{attempt.modelAttemptId}</dd>
          <dt>Model outcome</dt><dd>{attempt.outcome}</dd>
          <dt>Model version</dt><dd>{attempt.modelVersion}</dd>
          <dt>Prompt version</dt><dd>{attempt.promptVersion}</dd>
          <dt>Output schema version</dt><dd>{attempt.outputSchemaVersion}</dd>
          <dt>Original output</dt><dd><Reference reference={attempt.originalOutputRef} /></dd>
        </> : <>
          <dt>Provider attempt ID</dt><dd>{attempt.providerAttemptId}</dd>
          <dt>App</dt><dd>{APP_LABELS[attempt.app]}</dd>
          <dt>Operation</dt><dd>{attempt.operation}</dd>
          <dt>Transport</dt><dd>{attempt.transport}</dd>
          <dt>Transport outcome</dt><dd>{attempt.transportOutcome}</dd>
          <dt>Provider outcome</dt><dd>{attempt.providerOutcome}</dd>
          <dt>Reconciliation</dt><dd>{attempt.reconciliation.replaceAll('_', ' ')}</dd>
          <dt>Readback</dt><dd><Reference reference={attempt.readbackRef} /></dd>
        </>}
        <dt>Attempt evidence</dt><dd><Reference reference={attempt.reference} /></dd>
      </dl>
    </details>
  );
}

export function RunTimeline({ run, trace }: { run: RunView; trace?: TraceView }) {
  const currentTrace = trace?.runId === run.runId && trace.runRevision === run.revision ? trace : undefined;
  const providerAttempts = currentTrace?.attempts.filter(attempt => attempt.type === 'provider');

  return (
    <section className="pipeline-band" aria-labelledby="pipeline-heading">
      <p className="eyebrow">Workflow</p>
      <h2 id="pipeline-heading">Run timeline</h2>
      <p className="muted">Stage progress and independent assessments are recorded separately.</p>
      <ol className="pipeline" aria-label="Run stages">
        {PIPELINE_STAGE_IDS.map((stageId, index) => {
          const stage = run.stages.find(item => item.stageId === stageId);
          if (!stage) return null;
          const state = STAGE_STATES[stage.status];
          const modelAttempts = currentTrace?.attempts.filter(attempt => attempt.type === 'model' && attempt.role === stage.role);
          return (
            <li className="pipeline-stage" key={stageId} data-stage-id={stageId} data-status={stage.status}>
              <details>
                <summary>
                  <span className="eyebrow">{String(index + 1).padStart(2, '0')}</span>
                  <strong>{STAGE_LABELS[stageId]}</strong>
                  {stage.role && <span className="muted">{ROLE_LABELS[stage.role]}</span>}
                  <span className="status-chip" data-status={stage.status}>
                    <span aria-hidden="true">{state.icon} </span>{state.label}
                  </span>
                  <span className="muted">{stage.attemptCount} {stage.attemptCount === 1 ? 'attempt' : 'attempts'}</span>
                </summary>
                <dl className="detail-list">
                  <dt>Stage ID</dt><dd>{stage.stageId}</dd>
                  <dt>Span ID</dt><dd>Unavailable</dd>
                  <dt>First start</dt><dd><Timestamp value={stage.startedAt} /></dd>
                  <dt>Latest update</dt><dd><Timestamp value={stage.updatedAt} /></dd>
                  <dt>Reason</dt><dd>{stage.reason ?? 'Unavailable'}</dd>
                  <dt>Latest attempt</dt><dd><Reference reference={stage.latestAttemptRef} /></dd>
                  <dt>Evidence mode</dt><dd>{run.configuration.evidenceMode.replaceAll('_', ' ')}</dd>
                </dl>
                {stage.role && (modelAttempts?.length
                  ? modelAttempts.map(attempt => <AttemptDetails key={attempt.type === 'model' ? attempt.modelAttemptId : attempt.providerAttemptId} attempt={attempt} />)
                  : <p className="muted">Model attempt details unavailable.</p>)}
              </details>
            </li>
          );
        })}
      </ol>
      <details>
        <summary>Run and provider attempt details</summary>
        <dl className="detail-list">
          <dt>Run ID</dt><dd>{run.runId}</dd>
          <dt>Evaluation attempt ID</dt><dd>{run.evaluationAttemptId ?? 'Unavailable'}</dd>
          <dt>Runtime attempt IDs</dt><dd>{run.runtimeAttemptIds.length
            ? <ul>{run.runtimeAttemptIds.map(id => <li key={id}>{id}</li>)}</ul> : 'Unavailable'}</dd>
          <dt>Trace coverage</dt><dd>{currentTrace ? currentTrace.assessment.coverage.replaceAll('_', ' ') : 'Unavailable'}</dd>
        </dl>
        <p className="muted">Provider attempt stage and span IDs are unavailable in this projection.</p>
        {providerAttempts?.length ? providerAttempts.map(attempt => <AttemptDetails key={attempt.providerAttemptId} attempt={attempt} />)
          : <p className="muted">Provider attempt details unavailable.</p>}
        {currentTrace?.hasMore && <p className="muted">Additional attempt details are not included in this page.</p>}
        {trace && !currentTrace && <p className="muted">Trace details unavailable for this run revision.</p>}
      </details>
    </section>
  );
}
