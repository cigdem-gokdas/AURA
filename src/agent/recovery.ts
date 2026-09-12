import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExchangePositionSnapshot, StartupExchangeSnapshot } from '../execution/types.js';
import type { OpenPosition, StartupMonitorContext } from '../monitor/types.js';
import { isAuraProductionClientId } from '../okx/client-id.js';

interface RecoveryCheckpoint {
  version: 1;
  symbol: string;
  quantity: number;
  entryPrice: number;
  openedAt: number;
  updatedAt: number;
  protectionPlan: OpenPosition['protectionPlan'];
  protectionMode: OpenPosition['protectionMode'];
  currentStopPrice: number;
  /** Exchange identities needed to cancel attached protection after a restart. */
  entryOrderId?: string | null;
  entryClientOrderId?: string | null;
  attachedProtectionIds?: readonly string[];
}

const empty = (): StartupMonitorContext => ({ referencePrices: {}, openedAtBySymbol: {},
  protectionPlans: {}, protectionModes: {} });
const positive = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0;
const quantityTolerance = 1e-10;

export class OwnershipAmbiguityError extends Error {
  constructor(message: string) { super(`${message}; reconciliation required`); }
}

/** A single replaceable restart checkpoint, not an audit/event log. */
export class AgentRecoveryStore {
  readonly path: string;

  constructor(path = '.aura-recovery-state.json') { this.path = resolve(path); }

  async save(position: OpenPosition | null): Promise<void> {
    if (!position) {
      await unlink(this.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      return;
    }
    const checkpoint: RecoveryCheckpoint = {
      version: 1, symbol: position.symbol, quantity: position.quantity,
      entryPrice: position.weightedAverageEntryPrice, openedAt: position.openedAt,
      updatedAt: position.updatedAt, protectionPlan: position.protectionPlan,
      protectionMode: position.protectionMode, currentStopPrice: position.protection.currentStopPrice,
      entryOrderId: position.entryOrderId ?? null, entryClientOrderId: position.entryClientOrderId ?? null,
      attachedProtectionIds: [...(position.attachedProtectionIds ?? [])],
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async load(): Promise<RecoveryCheckpoint | null> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Invalid AURA recovery checkpoint'); }
    if (!value || typeof value !== 'object') throw new Error('Invalid AURA recovery checkpoint');
    const state = value as RecoveryCheckpoint;
    if (state.version !== 1 || !state.symbol || !positive(state.quantity) || !positive(state.entryPrice)
      || !Number.isSafeInteger(state.openedAt) || !Number.isSafeInteger(state.updatedAt)
      || !positive(state.currentStopPrice) || !state.protectionPlan
      || state.protectionPlan.symbol !== state.symbol || !positive(state.protectionPlan.stopDistanceAbsolute)
      || !positive(state.protectionPlan.stopDistanceFraction)
      || state.protectionMode !== state.protectionPlan.protectionMode
      || (state.entryOrderId != null && typeof state.entryOrderId !== 'string')
      || (state.entryClientOrderId != null && typeof state.entryClientOrderId !== 'string')
      || (state.attachedProtectionIds !== undefined && (!Array.isArray(state.attachedProtectionIds)
        || state.attachedProtectionIds.some(id => typeof id !== 'string' || !id)))) {
      throw new Error('Invalid AURA recovery checkpoint');
    }
    return state;
  }

  async context(snapshot: StartupExchangeSnapshot, references: Readonly<Record<string, number>>): Promise<StartupMonitorContext> {
    const checkpoint = await this.load();
    const claims = new Set<string>();
    const heldSymbols = new Set(snapshot.positions.filter(position => position.quantity > 0).map(position => position.symbol));
    for (const order of snapshot.openOrders) if (isAuraProductionClientId(order.clientOrderId)) claims.add(order.symbol);
    // Fills prove ownership only while AURA still appears to hold what it bought: the latest
    // AURA fill for a held symbol is a BUY, or AURA buys exceed AURA sells by more than fees
    // and lot rounding. A completed round trip (ENTRY buy then EXIT sell, or a smoke cleanup
    // SELL) leaves only inventory and sub-lot dust behind and must not block a restart.
    for (const symbol of heldSymbols) {
      const auraFills = snapshot.recentFills
        .filter(fill => fill.symbol === symbol && isAuraProductionClientId(fill.clientOrderId))
        .sort((a, b) => a.timestamp - b.timestamp);
      if (!auraFills.length) continue;
      const bought = auraFills.filter(fill => fill.side !== 'sell').reduce((sum, fill) => sum + fill.quantity, 0);
      const sold = auraFills.filter(fill => fill.side === 'sell').reduce((sum, fill) => sum + fill.quantity, 0);
      const stillOpen = auraFills.at(-1)!.side !== 'sell' || bought - sold > bought * 0.005 + quantityTolerance;
      if (stillOpen) claims.add(symbol);
    }
    if (claims.size > 1 || (checkpoint && [...claims].some(symbol => symbol !== checkpoint.symbol))) {
      throw new OwnershipAmbiguityError('Multiple AURA ownership claims');
    }
    if (!checkpoint) {
      if (claims.size) throw new OwnershipAmbiguityError('AURA order or fill found without a recovery checkpoint');
      return { ...empty(), referencePrices: references, managedPositions: [],
        unmanagedInventory: snapshot.positions.map(position => ({ ...position })) };
    }
    const holding = snapshot.positions.find(position => position.symbol === checkpoint.symbol);
    if (!holding || holding.quantity + quantityTolerance < checkpoint.quantity
      || checkpoint.updatedAt > snapshot.timestamp) {
      throw new OwnershipAmbiguityError('Missing or mismatched AURA position recovery checkpoint');
    }
    // A checkpoint that outlived its trade would turn wallet inventory into a phantom
    // position. AURA EXIT sells since the entry that cover the checkpointed quantity
    // prove the trade closed; the stale checkpoint must be reconciled, never restored.
    const soldSinceEntry = snapshot.recentFills
      .filter(fill => fill.symbol === checkpoint.symbol && fill.side === 'sell'
        && isAuraProductionClientId(fill.clientOrderId) && fill.timestamp >= checkpoint.openedAt)
      .reduce((sum, fill) => sum + fill.quantity, 0);
    if (soldSinceEntry >= checkpoint.quantity * 0.99) {
      throw new OwnershipAmbiguityError('Checkpointed AURA position was already sold by an AURA exit; stale checkpoint');
    }
    const managed: ExchangePositionSnapshot = { symbol: checkpoint.symbol, quantity: checkpoint.quantity,
      averageEntryPrice: checkpoint.entryPrice, updatedAt: snapshot.timestamp };
    const unmanaged = snapshot.positions.flatMap(position => {
      if (position.symbol !== checkpoint.symbol) return [{ ...position }];
      const remainder = position.quantity - checkpoint.quantity;
      return remainder > quantityTolerance ? [{ symbol: position.symbol, quantity: remainder,
        averageEntryPrice: null, updatedAt: position.updatedAt }] : [];
    });
    const plan = { ...checkpoint.protectionPlan,
      initialStopPrice: Math.max(checkpoint.protectionPlan.initialStopPrice, checkpoint.currentStopPrice) };
    return { referencePrices: references, openedAtBySymbol: { [checkpoint.symbol]: checkpoint.openedAt },
      protectionPlans: { [checkpoint.symbol]: plan }, protectionModes: { [checkpoint.symbol]: checkpoint.protectionMode },
      managedPositions: [managed], unmanagedInventory: unmanaged,
      exchangeLinks: { [checkpoint.symbol]: { entryOrderId: checkpoint.entryOrderId ?? null,
        entryClientOrderId: checkpoint.entryClientOrderId ?? null,
        attachedProtectionIds: [...(checkpoint.attachedProtectionIds ?? [])] } } };
  }
}
