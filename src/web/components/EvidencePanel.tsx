import type { RedactedReference, RunView } from '../../shared/api.js';

export interface EvidencePanelProps {
  run: RunView;
}

const selectionLabels: Record<RunView['commitments']['status'], string> = {
  pending: 'Selection pending',
  selected: 'Commitments selected',
  empty: 'No affected commitments',
  blocked: 'Selection blocked',
  incomplete: 'Retrieval incomplete',
};

function EvidenceReference({ reference }: { reference: RedactedReference }) {
  if (reference.availability === 'available' && reference.href) {
    return <a className="source-link" href={reference.href} target="_blank" rel="noopener noreferrer">
      {reference.label} <span aria-hidden="true">↗</span>
    </a>;
  }
  return <span>{reference.label} — {reference.availability === 'unauthorized' ? 'Unauthorized' : 'Unavailable'}</span>;
}

export function EvidencePanel({ run }: EvidencePanelProps) {
  const { incident, commitments } = run;
  const gaps = run.assessments.firstProposal.gaps;

  return (
    <section className="review-panel evidence-panel" aria-labelledby="evidence-heading">
      <p className="eyebrow">01 · Source review</p>
      <h2 id="evidence-heading">Evidence and commitments</h2>

      <div className="review-section">
        <h3>{incident.title || 'Incident title unavailable'}</h3>
        <a className="source-link" href={incident.url} target="_blank" rel="noopener noreferrer">
          View GitHub incident <span aria-hidden="true">↗</span>
        </a>
        <dl className="detail-list">
          <div><dt>Service</dt><dd>{incident.service}</dd></div>
          <div><dt>Environment</dt><dd>{incident.environment}</dd></div>
          <div><dt>Source retrieved at</dt><dd>Unavailable</dd></div>
        </dl>
        <p className="muted">Source retrieval time and individual cited facts are unavailable in this run view.</p>
      </div>

      <div className="review-section">
        <h3>Commitment selection</h3>
        <p className="status-chip" data-state={commitments.status}>
          <span aria-hidden="true">{commitments.status === 'blocked' || commitments.status === 'incomplete' ? '!' : '◇'}</span>{' '}
          {selectionLabels[commitments.status]}
        </p>
        {commitments.status === 'incomplete' && <p className="notice">Source retrieval is incomplete. An empty list does not establish that no commitments are affected.</p>}
        {commitments.status === 'blocked' && <p className="notice">Selection could not be accepted. Review the supplied reason before proceeding.</p>}
        {run.statusReason && <p>Run reason: <span>{run.statusReason.replaceAll('_', ' ')}</span></p>}

        <h4>Selected commitments</h4>
        {commitments.selected.length > 0 ? (
          <ul className="compact-list">
            {commitments.selected.map(commitment => <li key={commitment.commitmentId}>
              <strong>{commitment.company}</strong>
              <p className="muted">Commitment {commitment.commitmentId}</p>
              <p>Policy reason: {commitment.reason.replaceAll('_', ' ')}</p>
            </li>)}
          </ul>
        ) : (
          <p className="empty-state">{commitments.status === 'empty'
            ? 'No commitments selected by policy.'
            : 'Selected commitments unavailable; selection is not established.'}</p>
        )}

        <h4>Excluded commitments</h4>
        {commitments.excluded.length > 0 ? (
          <ul className="compact-list">
            {commitments.excluded.map(commitment => <li key={commitment.commitmentId}>
              <strong>{commitment.commitmentId}</strong>
              <p>Policy reason: {commitment.reason.replaceAll('_', ' ')}</p>
            </li>)}
          </ul>
        ) : <p className="empty-state">No excluded commitments supplied.</p>}
      </div>

      <div className="review-section">
        <h3>Supporting sources</h3>
        {commitments.evidenceRefs.length > 0 ? (
          <ul className="compact-list">
            {commitments.evidenceRefs.map(reference => <li key={reference.referenceId}>
              <EvidenceReference reference={reference} />
            </li>)}
          </ul>
        ) : <p className="empty-state">Source references unavailable.</p>}
        <p className="muted">A source link alone does not confirm a model claim.</p>
      </div>

      <div className="review-section">
        <h3>Model claims and supporting facts</h3>
        <p className="status-chip" data-state="unverified"><span aria-hidden="true">?</span> Claim evidence unavailable</p>
        <p className="muted">Individual claim text, supporting source fields, and claim verdicts are not supplied in this run view.</p>
        {gaps.length > 0 && <>
          <h4>First-proposal evidence gaps</h4>
          <ul className="compact-list">
            {gaps.map((gap, index) => <li key={`${gap.code}:${gap.referenceId ?? index}`}>
              <span>{gap.code.replaceAll('_', ' ')}</span>
              {gap.referenceId && <p className="muted">Reference: {gap.referenceId}</p>}
            </li>)}
          </ul>
        </>}
      </div>

      <details>
        <summary>Selection details</summary>
        <dl className="detail-list">
          <div><dt>Policy version</dt><dd>{commitments.policyVersion ?? 'Unavailable'}</dd></div>
          <div><dt>Selection status</dt><dd>{commitments.status}</dd></div>
          <div><dt>Run reason</dt><dd>{run.statusReason ?? 'Unavailable'}</dd></div>
        </dl>
      </details>
    </section>
  );
}
