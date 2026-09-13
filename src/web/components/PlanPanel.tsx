import type { ApprovalView, RunView } from '../../shared/api.js';

export interface PlanPanelProps {
  run: RunView;
}

const approvalLabels: Record<ApprovalView['status'], string> = {
  not_requested: 'Not requested',
  waiting: 'Waiting for Slack approval',
  approved: 'Approved in Slack',
  rejected: 'Rejected in Slack',
  expired: 'Approval expired',
  invalidated: 'Approval invalidated',
  unverified: 'Approval unverified',
};

const effectLabels = {
  task: 'HubSpot · Create follow-up task',
  note: 'HubSpot · Create commitment note',
  draft: 'Gmail · Create draft only',
  comment: 'GitHub · Add incident comment',
  thread: 'Slack · Add final summary',
};

function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{value}</time> : <>Unavailable</>;
}

export function PlanPanel({ run }: PlanPanelProps) {
  const { plan, approval } = run;
  const noAffected = run.productStatus === 'completed_no_affected_commitments';

  return (
    <section className="review-panel plan-panel" aria-labelledby="plan-heading">
      <p className="eyebrow">02 · Read-only review</p>
      <h2 id="plan-heading">Exact plan and approval</h2>
      {plan ? <>
        <p className="status-chip"><span aria-hidden="true">◇</span> Plan revision {plan.revision}</p>
        <p className="muted">Plan hash prefix: <code>{plan.planHash.slice(0, 12)}…</code></p>
        <p className="muted">Gmail creates drafts only. Each recipient, subject, and body below is the exact saved plan content.</p>
        {plan.entries.map(entry => {
          const selected = run.commitments.selected.find(commitment => commitment.commitmentId === entry.commitmentId);
          return <article className="draft-entry review-section" key={entry.commitmentId} aria-label={`Draft for ${selected?.company ?? entry.commitmentId}`}>
            <h3>{selected?.company ?? entry.commitmentId}</h3>
            <dl className="detail-list">
              <div><dt>Selected commitment</dt><dd>{entry.commitmentId}</dd></div>
              <div><dt>To</dt><dd>{entry.recipient}</dd></div>
              <div><dt>Subject</dt><dd>{entry.subject}</dd></div>
            </dl>
            <h4>Exact draft body</h4>
            <pre className="draft-body">{entry.body}</pre>
            <p className="muted">Draft only · No email delivery</p>
          </article>;
        })}
        <div className="review-section">
          <h3>Ordered effects</h3>
          <p className="muted">Each protected write requires independent readback before the next write.</p>
          <ol className="plan-effects compact-list">
            {plan.orderedEffectKeys.map(effectKey => {
              const effect = plan.effects.find(candidate => candidate.effectKey === effectKey);
              return <li key={effectKey}>
                <strong>{effect ? effectLabels[effect.kind] : 'Effect details unavailable'}</strong>
                {effect?.commitmentId && <p className="muted">Commitment {effect.commitmentId}</p>}
                {effect?.kind === 'task' && <p>Due <Timestamp value={effect.payload.dueAt} /></p>}
              </li>;
            })}
          </ol>
        </div>
      </> : <p className="empty-state">{noAffected
        ? 'No plan is required for a verified result with no affected commitments.'
        : 'Plan unavailable. Exact draft content has not been supplied.'}</p>}

      <div className="review-section">
        <h3>Slack approval</h3>
        {approval ? <>
          <p className="status-chip" data-state={approval.status}>
            <span aria-hidden="true">{approval.status === 'approved' ? '✓' : ['rejected', 'expired', 'invalidated'].includes(approval.status) ? '!' : '◷'}</span>{' '}
            {approvalLabels[approval.status]}
          </p>
          {approval.slackLink ? <a className="source-link" href={approval.slackLink} target="_blank" rel="noopener noreferrer">
            Open Slack review thread <span aria-hidden="true">↗</span>
          </a> : <p className="muted">Slack review link unavailable.</p>}
          <dl className="detail-list">
            <div><dt>Plan revision</dt><dd>{approval.planRevision}</dd></div>
            <div><dt>Approver</dt><dd>{approval.approver ?? 'Unavailable'}</dd></div>
            <div><dt>Decision time</dt><dd><Timestamp value={approval.decidedAt} /></dd></div>
            <div><dt>Expiry</dt><dd><Timestamp value={approval.expiresAt} /></dd></div>
          </dl>
          {approval.invalidationReason && <p className="notice">Invalidation reason: {approval.invalidationReason.replaceAll('_', ' ')}</p>}
          <p className="muted">Approval is bound to this immutable plan. Slack is the approval authority.</p>
        </> : <p className="empty-state">{noAffected ? 'Not applicable: this result requires no approval.' : 'Approval unavailable.'}</p>}
      </div>

      {plan && <details>
        <summary>Plan identity and effect keys</summary>
        <dl className="detail-list">
          <div><dt>Plan hash (SHA-256)</dt><dd><code>{plan.planHash}</code></dd></div>
          {approval && <div><dt>Approval plan hash</dt><dd><code>{approval.planHash}</code></dd></div>}
        </dl>
        <ol className="compact-list">
          {plan.orderedEffectKeys.map(effectKey => <li key={effectKey}><code>{effectKey}</code></li>)}
        </ol>
      </details>}
    </section>
  );
}
