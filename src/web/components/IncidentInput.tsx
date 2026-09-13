import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CreateRunCommandSchema, type ApiError } from '../../shared/api.js';

const ERROR_MESSAGES: Record<ApiError['code'], string> = {
  invalid_request: 'Enter the allowlisted synthetic GitHub issue URL shown below.',
  unauthenticated: 'Your operator session has expired. Sign in before continuing.',
  forbidden: 'You do not have access to this run or its evidence.',
  not_found: 'The requested run could not be found.',
  csrf_failed: 'The session could not be verified. Reload your authenticated session.',
  stale_revision: 'A stale response was ignored. The last accepted revision is still shown.',
  conflict: 'This command conflicts with the current run. Reload its latest state.',
  rate_limited: 'Requests are temporarily limited. Try again later.',
  unavailable: 'The service is temporarily unavailable. Previously loaded data is retained.',
  internal_error: 'The command could not be completed. Use the correlation ID for support.',
};

export interface IncidentInputProps {
  incidentUrl: string;
  allowedIncidentUrl: string;
  disabled?: boolean;
  error?: ApiError;
  onSubmit: (incidentUrl: string) => void;
}

export function IncidentInput({ incidentUrl, allowedIncidentUrl, disabled = false, error, onSubmit }: IncidentInputProps) {
  const [value, setValue] = useState(incidentUrl);
  const [validationError, setValidationError] = useState<ApiError>();
  const errorRef = useRef<HTMLDivElement>(null);
  const displayedError = validationError ?? error;
  useEffect(() => { setValue(incidentUrl); setValidationError(undefined); }, [incidentUrl]);
  useEffect(() => { if (validationError) errorRef.current?.focus(); }, [validationError]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const parsed = CreateRunCommandSchema.safeParse({ schemaVersion: 2, incidentUrl: value.trim() });
    if (!parsed.success || parsed.data.incidentUrl !== allowedIncidentUrl) {
      setValidationError({ schemaVersion: 2, code: 'invalid_request', retryable: false, correlationId: 'synthetic-url-validation' });
      return;
    }
    setValidationError(undefined);
    onSubmit(parsed.data.incidentUrl);
  }

  return <section className="incident-input" aria-label="Start or reopen incident">
    <form onSubmit={submit} noValidate>
      <label htmlFor="incident-url">GitHub incident URL</label>
      <div className="input-row">
        <input id="incident-url" type="url" value={value} onChange={event => setValue(event.target.value)}
          aria-describedby={displayedError ? 'incident-help incident-error' : 'incident-help'} aria-invalid={displayedError?.code === 'invalid_request'} disabled={disabled} />
        <button type="submit" disabled={disabled}>Start or reopen <span aria-hidden="true">↗</span></button>
      </div>
      <p id="incident-help" className="muted input-help">Synthetic preview · allowlisted issue: <span>{allowedIncidentUrl}</span></p>
    </form>
    {displayedError && <div id="incident-error" className="notice error-notice" role="alert" tabIndex={-1} ref={errorRef}>
      <strong>! {ERROR_MESSAGES[displayedError.code]}</strong>
      <p><code>{displayedError.code}</code> · {displayedError.retryable ? 'Retryable' : 'Not retryable'} · Correlation: <code>{displayedError.correlationId}</code></p>
    </div>}
  </section>;
}
