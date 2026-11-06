/**
 * Structured JSON-lines logger.
 *
 * Privacy rules (PRD 13.3): never log request bodies, client IPs, headers or secrets.
 * Enforced here by key-based redaction plus URL scrubbing (RPC URLs often embed API keys),
 * so a careless call site can't leak them.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const REDACT_KEY =
  /(priv|secret|password|passphrase|mnemonic|seed|apikey|api_key|token|authorization|cookie|^ip$|ipaddr|remote|forwarded|x-real-ip|headers?$|^body$|requestbody|rawbody|^key$|privatekey)/i;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const MAX_STRING = 2_000;

export function scrubString(s: string): string {
  const out = s.replace(URL_RE, '[url]');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/** Errors from viem embed request bodies / URLs; keep only the short, scrubbed parts. */
export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    const e = err as Error & { shortMessage?: string; code?: unknown; cause?: unknown };
    const out: LogFields = { name: e.name, message: scrubString(e.shortMessage ?? e.message.split('\n')[0] ?? '') };
    if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code;
    return out;
  }
  return { message: scrubString(String(err)) };
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(service: string, opts: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const envLevel = (process.env.LOG_LEVEL ?? '').toLowerCase() as LogLevel;
  const min = LEVELS[opts.level ?? (envLevel in LEVELS ? envLevel : 'info')];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < min) return;
    const rec = {
      t: now().toISOString(),
      level,
      service,
      msg: scrubString(msg),
      ...(sanitize(bindings) as LogFields),
      ...(sanitize(fields ?? {}) as LogFields),
    };
    write(JSON.stringify(rec));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger(service, opts, { ...bindings, ...b }),
  };
}
