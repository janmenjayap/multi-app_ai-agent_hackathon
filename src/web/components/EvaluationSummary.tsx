import { CriticalCountViewSchema, type EvaluationSummaryView, type RunView } from '../../shared/api.js';
import { AssessmentStatus } from './StatusBand.js';

const METRIC_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const;
const ASSESSMENT_LABELS = { trace: 'Process / trace', outcome: 'Independent outcome', firstProposal: 'Original first proposal', selectedPlan: 'Selected plan' };

function Configuration({ configuration }: { configuration: RunView['configuration'] }) {
  return <span>Models: {configuration.modelMode} · Providers: {configuration.providerMode} · Evidence mode: {configuration.evidenceMode}
    {configuration.fixtureId && <> · Fixture: <code>{configuration.fixtureId}</code></>}</span>;
}

function Measurements({ report }: { report: EvaluationSummaryView | null }) {
  return <>
    <h3>Saved M1–M7 measurements</h3>
    <ul className="metric-list">{METRIC_IDS.flatMap(metricId => {
      const metrics = report?.metrics.filter(metric => metric.metricId === metricId) ?? [];
      if (!metrics.length) return <li key={metricId} data-metric-id={metricId}>
        <strong>{metricId}</strong><span>Unavailable</span><span>No saved measurement</span>
      </li>;
      return metrics.map(metric => <li key={`${metric.metricId}-${metric.dimension}-${metric.role}`} data-metric-id={metric.metricId} data-dimension={metric.dimension} data-role={metric.role ?? ''}>
        <strong>{metric.metricId}</strong><span>{metric.dimension.replaceAll('_', ' ')} {metric.role}</span>
        {'denominator' in metric
          ? <span>{metric.numerator} / {metric.denominator} · {metric.availability === 'na' ? 'N/A (0 eligible)' : `Recorded rate: ${metric.value}`}</span>
          : <span>{metric.sampleCount} samples · {metric.availability === 'na' ? 'N/A (0 eligible)' : `median: ${metric.medianMs} ms · max: ${metric.maxMs} ms`} · censored: {metric.censoredCount}</span>}
      </li>);
    })}</ul>
    <h3>Saved critical counts</h3>
    <ul className="critical-list">{CriticalCountViewSchema.shape.code.options.map(code => {
      const count = report?.criticalCounts.find(item => item.code === code);
      return <li key={code} data-critical-code={code}>{code.replace(/([A-Z])/g, ' $1')}: <strong>{count?.count ?? 'Unavailable'}</strong></li>;
    })}</ul>
    <p className="muted">Unverified claims: Unavailable in this summary. Assessment and report gaps identify missing evidence.</p>
  </>;
}

export function EvaluationSummary({ run, synthetic = false }: { run: RunView; synthetic?: boolean }) {
  const report = run.report;
  return <section className="reliability-section" aria-labelledby="reliability-heading">
    <div className="section-heading"><div><p className="eyebrow">Independent evidence</p><h2 id="reliability-heading">Reliability summary</h2></div>
      <span className="status-chip">{synthetic ? '◇ Synthetic' : `Report provenance: ${report?.provenance.replaceAll('_', ' ') ?? 'Unavailable'}`}</span></div>
    <p className="muted input-help"><Configuration configuration={run.configuration} /></p>
    <div className="assessment-grid">
      {(['trace', 'outcome', 'firstProposal', 'selectedPlan'] as const).map(key => {
        const assessment = run.assessments[key];
        if (!assessment) return <div key={key} className="assessment-item"><h3>{ASSESSMENT_LABELS[key]}</h3><p className="muted">Unavailable</p></div>;
        return <div key={key} className="assessment-item">
          <h3>{ASSESSMENT_LABELS[key]}</h3>
          <AssessmentStatus assessment={assessment} firstProposal={key === 'firstProposal'} />
          <p className="muted">{assessment.confirmedCount} / {assessment.requiredCount} confirmed · {assessment.coverage.replaceAll('_', ' ')}</p>
          {(key === 'firstProposal' || assessment.humanLabelCount !== null) && <p className="muted">Human labels: {assessment.humanLabelCount ?? 'Unavailable'}{synthetic && ' · synthetic example'}</p>}
          {assessment.gaps.length > 0 && <ul className="gap-list">{assessment.gaps.map((gap, index) => <li key={`${gap.code}-${index}`}>△ {gap.code.replaceAll('_', ' ')}{gap.referenceId && <code> · {gap.referenceId}</code>}</li>)}</ul>}
          <details><summary>Assessment receipt</summary><dl className="detail-list">
            <div><dt>Evaluator</dt><dd>{assessment.evaluatorVersion ?? 'Unavailable'}</dd></div>
            <div><dt>Revision</dt><dd>{assessment.assessmentRevision ?? 'Unavailable'}</dd></div>
            <div><dt>Observed at</dt><dd>{assessment.observedAt ?? 'Unavailable'}</dd></div>
            <div><dt>Watermark</dt><dd>{assessment.watermark ?? 'Unavailable'}</dd></div>
          </dl></details>
        </div>;
      })}
    </div>
    {!report ? <>
      <p className="report-empty">{run.reportAvailability === 'pending' ? '◷ Report pending' : run.reportAvailability === 'unauthorized' ? '⊘ Report access unauthorized' : '? Report unavailable'}</p>
      {!synthetic && <details open><summary>Measurement availability</summary><Measurements report={null} /><p className="muted">Census and human-label coverage: Unavailable</p></details>}
    </> : <details className="report-details" open={!synthetic}>
      <summary>Saved {synthetic || report.provenance === 'synthetic' ? 'synthetic ' : ''}report · {report.reportId}</summary>
      <p className="muted">{report.evaluatorVersion} · manifest {report.manifestVersion} · cohort {report.cohortId} · revision {report.revision} · {report.provenance}</p>
      <p className="muted"><Configuration configuration={report.configuration} /></p>
      <p className="muted">Cutoff: {report.cutoffAt} · observed: {report.observedAt} · watermark: {report.watermark}</p>
      <p className="muted">Logical manifest hash: <code>{report.logicalManifestHash}</code></p>
      <dl className="census">{Object.entries(report.census).map(([key, count]) => <div key={key} data-census-key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{count}</dd></div>)}</dl>
      <Measurements report={report} />
      <p>Human-label coverage: {report.humanLabelCount === 0 ? 'Unverified (0 reviewed)' : `${report.humanLabelCount} reviewed${synthetic ? ' (synthetic example)' : ''}`}</p>
      {report.gaps.length > 0 && <ul className="gap-list">{report.gaps.map((gap, index) => <li key={`${gap.code}-${index}`}>△ {gap.code.replaceAll('_', ' ')}{gap.referenceId && <code> · {gap.referenceId}</code>}</li>)}</ul>}
      {report.reportRef?.href ? <a className="source-link" href={report.reportRef.href}>{report.reportRef.label}</a> : <p className="muted">Report evidence: {report.reportRef?.availability ?? 'Unavailable'}</p>}
    </details>}
  </section>;
}
