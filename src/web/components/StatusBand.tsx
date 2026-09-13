import type { AssessmentSummaryView, RunView } from '../../shared/api.js';

const PRODUCT_LABELS: Record<RunView['productStatus'], string> = {
  queued: '◷ Pending', running: '◷ Running', awaiting_approval: '◷ Awaiting Slack approval',
  safely_blocked: '⊘ Safely blocked', failed: '! Failed', failed_partial: '! Failed partial',
  completed: '✓ Completed', completed_no_affected_commitments: '✓ Completed · no affected commitments',
};
const ASSESSMENT_LABELS: Record<AssessmentSummaryView['status'], string> = {
  pending: '◷ Pending', pass: '✓ Pass', fail: '! Fail', incomplete: '△ Incomplete', unverified: '? Unverified', na: '— N/A',
};

export function AssessmentStatus({ assessment, firstProposal = false }: { assessment: AssessmentSummaryView; firstProposal?: boolean }) {
  return <><span className="status-chip" data-state={assessment.status}>{ASSESSMENT_LABELS[assessment.status]}</span>
    {firstProposal && assessment.humanLabelCount === 0 && assessment.status !== 'na' && <span className="muted">? Unverified (0 reviewed)</span>}
  </>;
}

export function StatusBand({ run }: { run: RunView }) {
  // Render each authoritative dimension separately; stage progress never determines a verdict.
  return <section className="status-band" aria-label="Run and assessment status">
    <div className="status-cell product-cell">
      <span className="eyebrow">Product status</span>
      <strong className="product-status" data-state={run.productStatus}>{PRODUCT_LABELS[run.productStatus]}</strong>
      {run.statusReason && <span className="status-reason">{run.statusReason.replaceAll('_', ' ')}</span>}
    </div>
    <div className="status-cell"><span className="eyebrow">Process / trace</span><AssessmentStatus assessment={run.assessments.trace} /></div>
    <div className="status-cell"><span className="eyebrow">Independent outcome</span><AssessmentStatus assessment={run.assessments.outcome} /></div>
    <div className="status-cell"><span className="eyebrow">First proposal</span><AssessmentStatus assessment={run.assessments.firstProposal} firstProposal /></div>
    <div className="verification-line">
      <span>Product readback: {run.verifiedAt ? <time dateTime={run.verifiedAt}>{run.verifiedAt}</time> : 'Unavailable'}</span>
      {run.approval?.slackLink ? <a className="source-link" href={run.approval.slackLink} target="_blank" rel="noreferrer">Open Slack review ↗</a> : <span>Slack review: {run.approval?.status.replaceAll('_', ' ') ?? 'Not requested'}</span>}
    </div>
  </section>;
}
