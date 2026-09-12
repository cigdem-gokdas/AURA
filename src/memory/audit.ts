import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export const AUDIT_EVENT_TYPES = [
  'STARTUP', 'PREFLIGHT', 'CALIBRATION', 'DEMO_SMOKE', 'STATE_TRANSITION',
  'MARKET_ACCEPTED', 'FEATURES_COMPUTED', 'REGIME_DECISION', 'CANDIDATE', 'OPPORTUNITY_SELECTED',
  'MARKET_CRITIC_RESULT', 'RISK_CERTIFICATE', 'ATK_MCP_CALL', 'ATK_MCP_HEALTH', 'DECISION_PROVENANCE',
  'EXECUTION_SUBMITTED', 'EXECUTION_RESULT', 'RECONCILIATION_REQUIRED', 'RECONCILIATION_RESOLVED',
  'PROTECTION', 'FILL', 'EXIT', 'DEGRADED', 'LOCKDOWN', 'ERROR',
] as const;
export type AuditEventType = typeof AUDIT_EVENT_TYPES[number];
export interface AuditEvent {
  eventType: AuditEventType;
  timestamp?: number;
  cycleId?: string;
  decisionId?: string;
  clientOrderId?: string;
  symbol?: string;
  payload: unknown;
}
export interface AuditRecord extends AuditEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: number;
  payload: unknown;
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /apikey|secret|passphrase|password|authorization|accesstoken|refreshtoken|credential|environment|processenv/.test(normalized)
    || normalized === 'env';
}
const sensitiveValue = /\b(?:OPENAI_API_KEY|OKX_[A-Z_]*(?:KEY|SECRET|PASSPHRASE)|api_?key|secret(?:Key)?|passphrase|authorization|password)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+|\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

/** Redacts recursively before anything reaches the append-only file or status bridge. */
export function redactAudit(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return value.slice(0, 4096).replace(sensitiveValue, '[REDACTED]');
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactAudit(item, depth + 1, seen));
  if (typeof value !== 'object') return null;
  if (seen.has(value)) throw new TypeError('Cyclic audit payload');
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    output[key] = sensitiveKey(key) ? '[REDACTED]' : redactAudit(child, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

async function lastSequence(handle: FileHandle): Promise<number> {
  const { size } = await handle.stat();
  if (!size) return 0;
  const length = Math.min(size, 65_536);
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, size - length);
  const tail = buffer.toString('utf8');
  if (!tail.endsWith('\n')) throw new Error('Audit history ends with an incomplete line');
  const lines = tail.trimEnd().split('\n');
  const last = lines.at(-1);
  if (!last) return 0;
  const parsed: unknown = JSON.parse(last);
  if (!parsed || typeof parsed !== 'object'
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (parsed as { eventType?: unknown }).eventType !== 'string')
    throw new Error('Invalid audit history record');
  const sequence = (parsed as { sequence?: unknown }).sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new Error('Invalid audit sequence');
  return sequence as number;
}

/** One serialized append queue. A failed write is sticky and is always surfaced. */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private fault: Error | null = null;
  private closed = false;
  private sequence: number;
  private constructor(readonly path: string, private readonly handle: FileHandle, sequence: number) {
    this.sequence = sequence;
  }

  static async open(path: string): Promise<AuditLog> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'a+', 0o600);
    try { return new AuditLog(path, handle, await lastSequence(handle)); }
    catch (error) { await handle.close(); throw error; }
  }

  append(event: AuditEvent): Promise<number> {
    if (this.closed) return Promise.reject(new Error('Audit log is closed'));
    if (this.fault) return Promise.reject(this.fault);
    const work = this.queue.then(async () => {
      if (this.fault) throw this.fault;
      const timestamp = event.timestamp ?? Date.now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('Invalid audit timestamp');
      const record: AuditRecord = { schemaVersion: 1, sequence: this.sequence + 1,
        timestamp, eventType: event.eventType, payload: redactAudit(event.payload) };
      for (const key of ['cycleId', 'decisionId', 'clientOrderId', 'symbol'] as const) {
        if (event[key] !== undefined) record[key] = redactAudit(event[key]) as string;
      }
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > 32_768) throw new RangeError('Audit event exceeds 32 KiB');
      await this.handle.writeFile(line);
      this.sequence = record.sequence;
      return this.sequence;
    });
    this.queue = work.then(() => undefined, error => {
      this.fault = error instanceof Error ? error : new Error('Audit write failed');
    });
    return work;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.fault) throw this.fault;
    await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown = null;
    try { await this.flush(); } catch (error) { failure = error; }
    try { await this.handle.close(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}
