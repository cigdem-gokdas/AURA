import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DemoSmokeRecoveryStore } from '../../src/agent/demo-smoke-recovery.js';

describe('persistent demo smoke ownership marker', () => {
  it('blocks startup while a smoke entry may be unresolved and clears only the matching ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aura-smoke-marker-'));
    try {
      const store = new DemoSmokeRecoveryStore(join(dir, 'pending.json'));
      const request = { symbol: 'ETH-USDT', cycleId: 'AURA-SMOKE-abcdef0123456789C',
        entryClientOrderId: 'AURASMOKEabcdef0123456789abcdef' };
      await store.assertClear();
      await store.begin(request, 1_789_213_220_000);
      await expect(store.assertClear()).rejects.toThrow('reconciliation required');
      await expect(store.begin(request, 1_789_213_220_001)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(store.clear('AURASMOKEanotherid')).rejects.toThrow('identity mismatch');
      await expect(store.assertClear()).rejects.toThrow('reconciliation required');
      await store.clear(request.entryClientOrderId);
      await store.assertClear();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
