import type { EffectView, RedactedReference, RunView } from '../../shared/api.js';

const EFFECT_LABELS: Record<EffectView['kind'], string> = {
  task: 'HubSpot task', note: 'HubSpot note', draft: 'Gmail draft',
  comment: 'GitHub impact comment', thread: 'Slack summary',
};

const LEDGER_LABELS: Record<EffectView['state'], { label: string; icon: string }> = {
  planned: { label: 'Planned', icon: '○' }, inflight: { label: 'In flight', icon: '↻' },
  applied: { label: 'Applied', icon: '•' }, verified: { label: 'Verified', icon: '✓' },
};

const OUTCOME_LABELS: Record<EffectView['outcome'], string> = {
  unattempted: 'Unattempted', applied: 'Applied', not_applied: 'Not applied', unknown: 'Unknown mutation outcome',
};

const COMPARISON_LABELS: Record<EffectView['comparison'], { label: string; icon: string }> = {
  pending: { label: 'Readback pending', icon: '◷' }, matched: { label: 'Readback matched', icon: '✓' },
  missing_readback: { label: 'Missing readback', icon: '?' }, mismatched: { label: 'Field mismatch', icon: '×' },
  unverified: { label: 'Unverified', icon: '?' }, conflict: { label: 'Conflicting artifact', icon: '×' },
  drift: { label: 'Later provider drift', icon: '!' },
};

const FIELD_LABELS: Record<EffectView['comparisons'][number]['field'], string> = {
  recipient: 'Recipient', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', body: 'Body', bodyDigest: 'Body digest',
  owner: 'Owner', company: 'Company', commitment: 'Commitment', dueAt: 'Due date', status: 'Status',
  draftOnly: 'Draft only', taskId: 'Task ID', noteId: 'Note ID', draftId: 'Draft ID', commentId: 'Comment ID',
  channel: 'Channel', artifactCount: 'Artifact count',
};

function Reference({ reference }: { reference: RedactedReference | null }) {
  if (!reference) return <span className="muted">Unavailable</span>;
  return reference.availability === 'available' && reference.href
    ? <a className="source-link" href={reference.href}>{reference.label}</a>
    : <span className="muted">{reference.label} · {reference.availability}</span>;
}

function ComparisonValue({ value }: { value: EffectView['comparisons'][number]['expected'] }) {
  if (value === null) return <span className="muted">Unavailable</span>;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}>{item}</li>)}</ul> : <>None (empty list)</>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{value === '' ? 'Empty string' : value}</span>;
}

export function EffectsPanel({ run }: { run: RunView }) {
  return (
    <section className="effects-section" aria-labelledby="effects-heading">
      <p className="eyebrow">Protected effects</p>
      <h2 id="effects-heading">App artifacts &amp; readback</h2>
      <p className="muted">Each artifact keeps its recorded ledger state, attempt outcome, and readback verdict.</p>
      {run.productStatus === 'failed_partial' && <p>Failed partial: accepted effects, uncertain outcomes, and unattempted work remain visible.</p>}
      {run.approval?.status === 'rejected' && <p>Slack approval rejected for plan revision {run.approval.planRevision}.</p>}
      {run.effects.length === 0 ? <p className="empty-state">{run.productStatus === 'completed_no_affected_commitments'
        ? 'No effects required. No affected commitments were selected.'
        : 'No planned effects recorded.'}</p> : (
        <ol aria-label="Planned effects in execution order">
          {run.effects.map(effect => {
            const ledger = LEDGER_LABELS[effect.state];
            const comparison = COMPARISON_LABELS[effect.comparison];
            return (
              <li className="effect-row" key={effect.effectKey} data-effect-key={effect.effectKey}>
                <div>
                  <h3>{EFFECT_LABELS[effect.kind]}</h3>
                  {effect.kind === 'draft' && <p className="muted">Draft only</p>}
                  <span className="status-chip" data-status={effect.state}>
                    <span aria-hidden="true">{ledger.icon} </span>Ledger: {ledger.label}
                  </span>{' '}
                  <span className="status-chip" data-status={effect.comparison}>
                    <span aria-hidden="true">{comparison.icon} </span>{comparison.label}
                  </span>
                  <p>Attempt outcome: <strong>{OUTCOME_LABELS[effect.outcome]}</strong>
                    {effect.result && <> · {effect.result === 'created' ? 'Created' : 'Reused'}</>}</p>
                  {effect.providerLink && <a className="source-link" href={effect.providerLink} target="_blank" rel="noreferrer">Open {EFFECT_LABELS[effect.kind]} <span aria-hidden="true">↗</span><span className="muted"> (new tab)</span></a>}
                </div>
                <details>
                  <summary>Artifact identity and readback fields</summary>
                  <dl className="detail-list">
                    <dt>Effect key</dt><dd>{effect.effectKey}</dd>
                    <dt>Provider ID</dt><dd>{effect.providerId ?? 'Unavailable'}</dd>
                    <dt>Creation result</dt><dd>{effect.result ?? 'Unavailable'}</dd>
                    <dt>Verified at</dt><dd>{effect.verifiedAt ? <time dateTime={effect.verifiedAt}>{effect.verifiedAt}</time> : 'Unavailable'}</dd>
                    <dt>Readback evidence</dt><dd><Reference reference={effect.readbackRef} /></dd>
                  </dl>
                  {effect.comparisons.length === 0 ? <p className="muted">Field comparisons unavailable.</p> : (
                    <ul aria-label={`${EFFECT_LABELS[effect.kind]} field comparisons`}>
                      {effect.comparisons.map((field, index) => (
                        <li key={`${field.field}-${index}`}>
                          <h4>{FIELD_LABELS[field.field]} · {field.verdict === 'unavailable' ? 'Unavailable' : field.verdict === 'matched' ? 'Matched' : 'Mismatched'}</h4>
                          <dl className="detail-list">
                            <dt>Expected</dt><dd><ComparisonValue value={field.expected} /></dd>
                            <dt>Observed</dt><dd><ComparisonValue value={field.observed} /></dd>
                            <dt>Evidence</dt><dd><Reference reference={field.evidenceRef} /></dd>
                          </dl>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
