import { OkxConnectorError } from './types.js';

/** OKX/ATK may omit fillId; tradeId and billId are stable exchange identities. */
export function normalizeOkxFillIdentity(row: Record<string, unknown>): {
  fillId: string;
  tradeId: string | null;
  billId: string | null;
} {
  const identifier = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const fillId = identifier(row.fillId);
  const tradeId = identifier(row.tradeId);
  const billId = identifier(row.billId);
  const identity = fillId ?? tradeId ?? billId;
  if (!identity) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Missing or invalid fill ID');
  return { fillId: identity, tradeId, billId };
}
