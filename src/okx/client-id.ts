import { randomBytes } from 'node:crypto';

export type AuraOkxClientIdKind = 'ENTRY' | 'EXIT' | 'SMOKE' | 'PROT';

const TOKEN_BYTES = 11; // 88 random bits; every prefix plus token stays below 32 characters.
const OKX_CLIENT_ID = /^[A-Za-z0-9]{1,32}$/;

/** The only generator for AURA identifiers sent in OKX client-ID fields. */
export function createOkxClientId(kind: AuraOkxClientIdKind): string {
  return `AURA${kind}${randomBytes(TOKEN_BYTES).toString('hex')}`;
}

export function isOkxClientId(value: unknown): value is string {
  return typeof value === 'string' && OKX_CLIENT_ID.test(value);
}

export function isAuraOkxClientId(value: unknown, kind: AuraOkxClientIdKind): value is string {
  return isOkxClientId(value)
    && new RegExp(`^AURA${kind}[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(value);
}

/** Legacy IDs remain evidence during restart; new exchange submissions never generate them. */
export function isAuraProductionClientId(value: unknown): value is string {
  return isAuraOkxClientId(value, 'ENTRY') || isAuraOkxClientId(value, 'EXIT')
    || isAuraOkxClientId(value, 'PROT')
    || (typeof value === 'string' && /^aura\d+_\d+$/.test(value));
}
