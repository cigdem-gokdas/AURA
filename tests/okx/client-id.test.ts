import { describe, expect, it } from 'vitest';
import { createOkxClientId, isAuraOkxClientId, isAuraProductionClientId,
  isOkxClientId, type AuraOkxClientIdKind } from '../../src/okx/client-id.js';

describe('central OKX client ID generation', () => {
  it.each(['ENTRY', 'EXIT', 'SMOKE', 'PROT'] as const)(
    'generates unique, exchange-safe %s identifiers', kind => {
      const generated = Array.from({ length: 500 }, () => createOkxClientId(kind));
      expect(new Set(generated).size).toBe(generated.length);
      for (const id of generated) {
        expect(id).toMatch(/^[A-Za-z0-9]+$/);
        expect(id.length).toBeLessThanOrEqual(32);
        expect(id).not.toMatch(/[-_\s\W]/);
        expect(isOkxClientId(id)).toBe(true);
        expect(isAuraOkxClientId(id, kind)).toBe(true);
      }
    },
  );

  it('keeps client IDs separate from internal cycle and decision identifiers', () => {
    const kinds: AuraOkxClientIdKind[] = ['ENTRY', 'EXIT', 'SMOKE', 'PROT'];
    const ids = kinds.map(createOkxClientId);
    expect(new Set(ids).size).toBe(kinds.length);
    expect(ids).toMatchObject([
      expect.stringMatching(/^AURAENTRY[0-9a-f]{22}$/),
      expect.stringMatching(/^AURAEXIT[0-9a-f]{22}$/),
      expect.stringMatching(/^AURASMOKE[0-9a-f]{22}$/),
      expect.stringMatching(/^AURAPROT[0-9a-f]{22}$/),
    ]);
    for (const bad of ['AURA-SMOKE-abc', 'aura100_1', 'AURA ENTRY', 'AURA.ENTRY',
      'A'.repeat(33), '']) expect(isOkxClientId(bad)).toBe(false);
    expect(isAuraProductionClientId(ids[0])).toBe(true);
    expect(isAuraProductionClientId(ids[1])).toBe(true);
    expect(isAuraProductionClientId(ids[2])).toBe(false);
    expect(isAuraProductionClientId('aura100_1')).toBe(true); // Historic ownership evidence only.
  });
});
