export interface AtkToolTrace {
  sequence?: number;
  timestamp: number;
  lane: 'READ' | 'WRITE';
  toolName: string;
  purpose: string;
  symbol: string | null;
  profile: 'demo' | 'live';
  latencyMs: number;
  success: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  cycleId: string | null;
  decisionId: string | null;
}

/** No arguments, payloads, credentials, or environment values enter this buffer. */
export class AtkTraceBuffer {
  private readonly buffer: AtkToolTrace[] = [];
  private sequence = 0;
  constructor(private readonly limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid trace limit');
  }
  record(trace: AtkToolTrace): void {
    try { this.buffer.push({ ...trace, sequence: ++this.sequence }); if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit); }
    catch { /* Telemetry cannot affect execution. */ }
  }
  recent(): readonly AtkToolTrace[] { return this.buffer.map(item => ({ ...item })); }
}
