import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DemoSmokeRequest } from '../execution/types.js';
import { OwnershipAmbiguityError } from './recovery.js';
import { isAuraOkxClientId } from '../okx/client-id.js';

interface SmokeMarker {
  version: 1;
  symbol: string;
  cycleId: string;
  entryClientOrderId: string;
  startedAt: number;
}

/** An exclusive marker survives a crash after a smoke order was attempted. */
export class DemoSmokeRecoveryStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  async assertClear(): Promise<void> {
    try { await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new OwnershipAmbiguityError('Pending DEMO_SMOKE ownership checkpoint');
  }

  async begin(request: Pick<DemoSmokeRequest, 'symbol' | 'cycleId' | 'entryClientOrderId'>,
    startedAt: number): Promise<void> {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0
      || !(isAuraOkxClientId(request.entryClientOrderId, 'SMOKE')
        || isAuraOkxClientId(request.entryClientOrderId, 'ENTRY'))) throw new Error('Invalid DEMO_SMOKE marker');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const marker: SmokeMarker = { version: 1, symbol: request.symbol,
      cycleId: request.cycleId, entryClientOrderId: request.entryClientOrderId, startedAt };
    const handle = await open(this.path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(marker)); await handle.sync(); }
    finally { await handle.close(); }
  }

  async clear(entryClientOrderId: string): Promise<void> {
    const raw = await readFile(this.path, 'utf8');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Invalid DEMO_SMOKE marker'); }
    if (!value || typeof value !== 'object' || (value as SmokeMarker).version !== 1
      || (value as SmokeMarker).entryClientOrderId !== entryClientOrderId) {
      throw new Error('DEMO_SMOKE marker identity mismatch');
    }
    await unlink(this.path);
  }
}
