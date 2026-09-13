import { Buffer } from 'node:buffer';

import { AdapterError } from './common/errors.js';

const EFFECT_MARKER_HEADER = 'x-promiseguard-effect-key';

export interface GmailMimeInput {
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  effectMarker: string;
}

export interface ParsedGmailMime {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  effectMarkers: string[];
}

interface MimeEntity {
  headers: Map<string, string[]>;
  body: string;
}

function malformed(): never {
  throw new AdapterError('malformed_response', {
    providerOutcome: 'error',
    isRetryable: false,
  });
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) malformed();
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return malformed();
  }
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/[\t\r\n ]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) malformed();
  try {
    return Buffer.from(compact, 'base64');
  } catch {
    return malformed();
  }
}

function decodeQuotedPrintable(value: string): Uint8Array {
  const unfolded = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length;) {
    if (unfolded[index] === '=') {
      const hex = unfolded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) malformed();
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    const encoded = Buffer.from(unfolded[index], 'utf8');
    bytes.push(...encoded);
    index += 1;
  }
  return Uint8Array.from(bytes);
}

function decodeText(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return malformed();
  }
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset: string, encoding: string, encoded: string) => {
    const bytes = encoding.toLowerCase() === 'b'
      ? decodeBase64(encoded)
      : decodeQuotedPrintable(encoded.replace(/_/g, ' '));
    return decodeText(bytes, charset);
  });
}

function parseEntity(raw: string): MimeEntity {
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator || separator.index === undefined) malformed();
  const headerBlock = raw.slice(0, separator.index);
  const body = raw.slice(separator.index + separator[0].length);
  const unfolded: string[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[\t ]/.test(line)) {
      if (unfolded.length === 0) malformed();
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const headers = new Map<string, string[]>();
  for (const line of unfolded) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) malformed();
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return { headers, body };
}

function headerParameter(value: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const match = pattern.exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

function contentType(entity: MimeEntity): string {
  return entity.headers.get('content-type')?.[0] ?? 'text/plain; charset=us-ascii';
}

function decodeEntityBody(entity: MimeEntity): string {
  const type = contentType(entity);
  if (/^multipart\//i.test(type)) {
    const boundary = headerParameter(type, 'boundary');
    if (!boundary || /[\r\n]/.test(boundary)) malformed();
    const delimiter = `--${boundary}`;
    const parts = entity.body.split(delimiter).slice(1);
    for (const rawPart of parts) {
      if (rawPart.startsWith('--')) break;
      const part = parseEntity(rawPart.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
      const disposition = part.headers.get('content-disposition')?.[0] ?? '';
      if (/^text\/plain(?:;|$)/i.test(contentType(part)) && !/^attachment(?:;|$)/i.test(disposition)) {
        return decodeEntityBody(part);
      }
    }
    return malformed();
  }
  if (!/^text\/plain(?:;|$)/i.test(type)) malformed();

  const transferEncoding = (entity.headers.get('content-transfer-encoding')?.[0] ?? '8bit').toLowerCase();
  const bytes = transferEncoding === 'base64'
    ? decodeBase64(entity.body)
    : transferEncoding === 'quoted-printable'
      ? decodeQuotedPrintable(entity.body)
      : transferEncoding === '7bit' || transferEncoding === '8bit' || transferEncoding === 'binary'
        ? Buffer.from(entity.body, 'utf8')
        : malformed();
  const charset = headerParameter(type, 'charset') ?? 'us-ascii';
  return decodeText(bytes, charset).replace(/\r\n?/g, '\n');
}

function addresses(values: string[]): string[] {
  const result: string[] = [];
  const addressPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi;
  for (const value of values) {
    const decoded = decodeEncodedWords(value);
    for (const match of decoded.matchAll(addressPattern)) result.push(match[0]);
  }
  return result;
}

function encodeSubject(value: string): string {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

export function encodeGmailDraftMime(input: GmailMimeInput): string {
  if ([input.to, input.subject, input.effectMarker, ...input.cc, ...input.bcc].some(value => /[\r\n]/.test(value))) {
    malformed();
  }
  const headers = [
    `To: ${input.to}`,
    ...input.cc.map(value => `Cc: ${value}`),
    ...input.bcc.map(value => `Bcc: ${value}`),
    `Subject: ${encodeSubject(input.subject)}`,
    `X-PromiseGuard-Effect-Key: ${input.effectMarker}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(input.body, 'utf8').toString('base64'))}`;
}

export function encodeGmailRawMessage(input: GmailMimeInput): string {
  return Buffer.from(encodeGmailDraftMime(input), 'utf8').toString('base64url');
}

export function parseGmailRawMessage(raw: string): ParsedGmailMime {
  const entity = parseEntity(decodeText(decodeBase64Url(raw), 'utf-8'));
  return {
    to: addresses(entity.headers.get('to') ?? []),
    cc: addresses(entity.headers.get('cc') ?? []),
    bcc: addresses(entity.headers.get('bcc') ?? []),
    subject: decodeEncodedWords(entity.headers.get('subject')?.[0] ?? ''),
    body: decodeEntityBody(entity),
    effectMarkers: (entity.headers.get(EFFECT_MARKER_HEADER) ?? []).map(decodeEncodedWords),
  };
}