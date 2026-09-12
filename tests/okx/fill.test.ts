import { describe, expect, it } from 'vitest';
import { normalizeOkxFillIdentity } from '../../src/okx/fill.js';

describe('canonical OKX fill identity', () => {
  it('prefers fillId, then tradeId, then billId without losing the source IDs', () => {
    expect(normalizeOkxFillIdentity({ fillId: 'f', tradeId: 't', billId: 'b' }))
      .toEqual({ fillId: 'f', tradeId: 't', billId: 'b' });
    expect(normalizeOkxFillIdentity({ tradeId: '830754418', billId: 'bill' }))
      .toEqual({ fillId: '830754418', tradeId: '830754418', billId: 'bill' });
    expect(normalizeOkxFillIdentity({ billId: 'bill' }))
      .toEqual({ fillId: 'bill', tradeId: null, billId: 'bill' });
  });

  it('rejects a fill lacking all three exchange identifiers', () => {
    expect(() => normalizeOkxFillIdentity({ ordId: '3916317316499066880' }))
      .toThrow('Missing or invalid fill ID');
  });
});
