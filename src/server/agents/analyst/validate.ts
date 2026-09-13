import { AnalystInputSchema, parseIncidentAssessment,
  type AnalystInput, type IncidentAssessment } from '../../../shared/agents.js';

/** Mechanical constraints only: citation membership is not source entailment. */
export function validateIncidentAssessment(value: unknown, input: AnalystInput): IncidentAssessment {
  const sources = AnalystInputSchema.parse(input).sources;
  if (new Set(sources.map(source => source.factId)).size !== sources.length)
    throw new Error('duplicate_source_fact');
  const assessment = parseIncidentAssessment(value, sources);
  const prose = [...assessment.facts.map(claim => claim.text),
    ...assessment.contradictions.map(contradiction => contradiction.reason),
    ...assessment.unknowns, assessment.candidateChange.reason];
  if (prose.some(text => text.trim().length === 0)) throw new Error('blank_assessment_text');
  const citationLists = [...assessment.facts.map(claim => claim.sourceFactIds),
    ...assessment.contradictions.map(contradiction => contradiction.factIds),
    assessment.candidateChange.sourceFactIds];
  if (citationLists.some(ids => new Set(ids).size !== ids.length))
    throw new Error('duplicate_source_citation');
  if (assessment.candidateChange.status === 'supported' && !assessment.candidateChange.sourceFactIds.length)
    throw new Error('supported_candidate_requires_citation');
  if ((assessment.candidateChange.status !== 'supported' || assessment.contradictions.length > 0 ||
      assessment.facts.length === 0) && assessment.unknowns.length === 0)
    throw new Error('assessment_requires_uncertainty');
  // Do not rewrite or "correct" original output. A01 persists validation failures.
  // No string heuristic can certify causal evidence, freshness or completeness.
  return assessment;
}
