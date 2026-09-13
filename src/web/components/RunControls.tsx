import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CreateRunCommandSchema, type CommandResult, type RunView } from '../../shared/api.js';
import type { ConsoleApiError } from '../api/client.js';

export interface RunControlsProps {
  run: RunView | null;
  pending: boolean;
  connection: 'connected' | 'reconnecting' | 'offline' | 'session_expired' | 'unauthorized';
  error: ConsoleApiError | null;
  commandResult: CommandResult | null;
  onStart: (incidentUrl: string) => Promise<void>;
  onReconcile: () => Promise<void>;
  onReconnect: () => void;
}

const COMMAND_MESSAGES: Record<CommandResult['disposition'], string> = {
  created: 'Run accepted. Reading its saved status.',
  reopened: 'Existing run reopened.',
  scheduled: 'Reconciliation scheduled. Reading its saved status.',
  already_scheduled: 'Work is already scheduled.',
  not_eligible: 'This run is not eligible for reconciliation.',
};

export function RunControls({ run, pending, connection, error, commandResult, onStart, onReconcile, onReconnect }: RunControlsProps) {
  const [incidentUrl, setIncidentUrl] = useState(run?.incident.url ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const busy = pending || submitting;
  const disabled = busy || connection !== 'connected';
  const displayedMessage = localError ?? error?.message;
  const canReconcile = run?.productStatus === 'failed_partial';

  useEffect(() => { if (run) setIncidentUrl(run.incident.url); }, [run?.incident.url]);
  useEffect(() => { if (displayedMessage) errorRef.current?.focus(); }, [displayedMessage]);

  async function command(action: () => Promise<void>) {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLocalError(null);
    try { await action(); }
    catch { setLocalError('The command could not be completed. Reconnect to read its saved status before retrying.'); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submittingRef.current) return;
    const parsed = CreateRunCommandSchema.safeParse({ schemaVersion: 2, incidentUrl: incidentUrl.trim() });
    if (!parsed.success) {
      setLocalError('Enter a GitHub issue URL such as https://github.com/owner/repository/issues/42.');
      errorRef.current?.focus();
      return;
    }
    void command(() => onStart(parsed.data.incidentUrl));
  }

  return <section className="incident-input" aria-label="Start or reopen incident">
    <form onSubmit={submit} noValidate aria-busy={busy}>
      <label htmlFor="incident-url">GitHub incident URL</label>
      <div className="input-row">
        <input id="incident-url" type="url" value={incidentUrl}
          onChange={event => { setIncidentUrl(event.target.value); setLocalError(null); }}
          aria-describedby={displayedMessage ? 'incident-help incident-error' : 'incident-help'}
          aria-invalid={Boolean(localError) || error?.code === 'invalid_request'} disabled={disabled} />
        <button type="submit" disabled={disabled}>{busy ? 'Command pending…' : 'Start or reopen ↗'}</button>
      </div>
      <p id="incident-help" className="muted input-help">The server checks repository access and reopens an existing run for this incident. Approval takes place in Slack.</p>
    </form>
    <div className="review-section">
      {canReconcile && <><button type="button" disabled={disabled} onClick={() => { void command(onReconcile); }}>Request reconciliation</button>{' '}</>}
      <button type="button" className="quiet-button" disabled={busy} onClick={() => { setLocalError(null); onReconnect(); }}>Reconnect</button>
      {canReconcile && <p className="muted input-help">The server checks whether this partial run can be reconciled. Previously accepted effects and Slack approval remain authoritative.</p>}
      {connection !== 'connected' && <p className="muted input-help">
        {connection === 'session_expired' ? 'Restore your authenticated session, then reconnect to read the saved run.'
          : connection === 'unauthorized' ? 'Restore access, then reconnect to read the saved run.'
          : connection === 'offline' ? 'Offline. Reconnect when the network is available; the last saved run remains visible.'
          : 'Reconnecting to the saved run. Commands are paused.'}
      </p>}
    </div>
    {displayedMessage && <div id="incident-error" className="notice error-notice" role="alert" tabIndex={-1} ref={errorRef}>
      <strong>! {displayedMessage}</strong>
      {!localError && error && <p><code>{error.code}</code> · {error.retryable ? 'Retryable' : 'Not retryable'}
        {error.apiError && <> · Correlation: <code>{error.apiError.correlationId}</code></>}</p>}
    </div>}
    {commandResult && <div className="notice fixture-notice" role="status">
      <p>{COMMAND_MESSAGES[commandResult.disposition]} <code>{commandResult.disposition}</code></p>
      <p className="muted">Command <code>{commandResult.commandId}</code> · Run <code>{commandResult.runId}</code> · revision {commandResult.revision}</p>
    </div>}
  </section>;
}
