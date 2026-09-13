import { parseAuditVerdict, type AuditorInput, type AuditVerdict } from '../../../shared/agents.js';

/** Mechanical coverage/reference checks; a known citation cannot prove entailment. */
export function validateAuditVerdict(value: unknown, input: AuditorInput): AuditVerdict {
  const verdict = parseAuditVerdict(value, input);
  for (const entry of verdict.entries) {
    if ([...entry.findings, ...entry.requiredFactFindings].some(finding => !finding.reason.trim()))
      throw new Error('blank_audit_reason');
    for (const finding of entry.findings) {
      if (new Set(finding.sourceFactIds).size !== finding.sourceFactIds.length)
        throw new Error('duplicate_source_citation');
      if (finding.verdict === 'supported' && finding.sourceFactIds.length === 0)
        throw new Error('supported_finding_requires_citation');
    }
  }
  // Keep block/uncertain as successful findings, never errors to repair or approve.
  // A01 retains invalid raw responses before this validator can reject them.
  return verdict;
}
