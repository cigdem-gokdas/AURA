import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExchangePositionSnapshot, StartupExchangeSnapshot } from '../execution/types.js';
import type { OpenPosition, StartupMonitorContext } from '../monitor/types.js';
import { isAuraProductionClientId } from '../okx/client-id.js';

interface RecoveryCheckpoint {
  symbol: string;
  quantity: number;
  entryPrice: number;
  openedAt: number;
  updatedAt: number;
  protectionPlan: OpenPosition['protectionPlan'];
  protectionMode: OpenPosition['protectionMode'];
  currentStopPrice: number;
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

/** Replaceable restart state; the separate audit log remains append-only. */
export class AgentRecoveryStore {
  readonly path: string;
  constructor(path = '.aura-recovery-state.json') { this.path = resolve(path); }

  async save(position: OpenPosition | null): Promise<void> {
    await this.savePositions(position ? [position] : []);
  }

  async savePositions(positions: readonly OpenPosition[]): Promise<void> {
    if (positions.length > 5 || new Set(positions.map(item => item.symbol)).size !== positions.length)
      throw new Error('Invalid multi-position checkpoint');
    if (!positions.length) {
      await unlink(this.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      return;
    }
    const checkpoints: RecoveryCheckpoint[] = positions.map(position => ({
      symbol: position.symbol, quantity: position.quantity,
      entryPrice: position.weightedAverageEntryPrice, openedAt: position.openedAt,
      updatedAt: position.updatedAt, protectionPlan: position.protectionPlan,
      protectionMode: position.protectionMode, currentStopPrice: position.protection.currentStopPrice,
      entryOrderId: position.entryOrderId ?? null, entryClientOrderId: position.entryClientOrderId ?? null,
      attachedProtectionIds: [...(position.attachedProtectionIds ?? [])],
    }));
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, positions: checkpoints }), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async load(): Promise<RecoveryCheckpoint[]> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Invalid AURA recovery checkpoint'); }
    if (!value || typeof value !== 'object') throw new Error('Invalid AURA recovery checkpoint');
    const document = value as { version?: unknown; positions?: unknown } & RecoveryCheckpoint;
    // Legacy one-position checkpoint remains readable after upgrade.
    const checkpoints: unknown[] = document.version === 1 ? [document]
      : document.version === 2 && Array.isArray(document.positions) ? document.positions : [];
    if (!checkpoints.length || checkpoints.length > 5) throw new Error('Invalid AURA recovery checkpoint');
    const states = checkpoints as RecoveryCheckpoint[];
    if (new Set(states.map(item => item.symbol)).size !== states.length || states.some(state =>
      !state.symbol || !positive(state.quantity) || !positive(state.entryPrice)
      || !Number.isSafeInteger(state.openedAt) || !Number.isSafeInteger(state.updatedAt)
      || !positive(state.currentStopPrice) || !state.protectionPlan
      || state.protectionPlan.symbol !== state.symbol || !positive(state.protectionPlan.stopDistanceAbsolute)
      || !positive(state.protectionPlan.stopDistanceFraction)
      || state.protectionMode !== state.protectionPlan.protectionMode
      || (state.entryOrderId != null && typeof state.entryOrderId !== 'string')
      || (state.entryClientOrderId != null && typeof state.entryClientOrderId !== 'string')
      || (state.attachedProtectionIds !== undefined && (!Array.isArray(state.attachedProtectionIds)
        || state.attachedProtectionIds.some(id => typeof id !== 'string' || !id))))) {
      throw new Error('Invalid AURA recovery checkpoint');
    }
    return states;
  }

  async ownedSymbols(): Promise<readonly string[]> { return (await this.load()).map(item => item.symbol); }

  async context(snapshot: StartupExchangeSnapshot, references: Readonly<Record<string, number>>): Promise<StartupMonitorContext> {
    const checkpoints = await this.load();
    const bySymbol = new Map(checkpoints.map(item => [item.symbol, item]));
    const claims = new Set<string>();
    const heldSymbols = new Set(snapshot.positions.filter(position => position.quantity > 0).map(position => position.symbol));
    for (const order of snapshot.openOrders) if (isAuraProductionClientId(order.clientOrderId)) claims.add(order.symbol);
    for (const symbol of heldSymbols) {
      const auraFills = snapshot.recentFills
        .filter(fill => fill.symbol === symbol && isAuraProductionClientId(fill.clientOrderId))
        .sort((a, b) => a.timestamp - b.timestamp);
      if (!auraFills.length) continue;
      const bought = auraFills.filter(fill => fill.side !== 'sell').reduce((sum, fill) => sum + fill.quantity, 0);
      const sold = auraFills.filter(fill => fill.side === 'sell').reduce((sum, fill) => sum + fill.quantity, 0);
      if (auraFills.at(-1)!.side !== 'sell' || bought - sold > bought * 0.005 + quantityTolerance)
        claims.add(symbol);
    }
    if ([...claims].some(symbol => !bySymbol.has(symbol)))
      throw new OwnershipAmbiguityError('AURA order or fill found without a recovery checkpoint');
    const managed: ExchangePositionSnapshot[] = [];
    const openedAtBySymbol: Record<string, number> = {};
    const protectionPlans: Record<string, OpenPosition['protectionPlan']> = {};
    const protectionModes: Record<string, OpenPosition['protectionMode']> = {};
    const exchangeLinks: Record<string, { entryOrderId: string | null; entryClientOrderId: string | null;
      attachedProtectionIds: readonly string[] }> = {};
    for (const checkpoint of checkpoints) {
      const holding = snapshot.positions.find(position => position.symbol === checkpoint.symbol);
      if (!holding || holding.quantity + quantityTolerance < checkpoint.quantity
        || checkpoint.updatedAt > snapshot.timestamp)
        throw new OwnershipAmbiguityError('Missing or mismatched AURA position recovery checkpoint');
      const soldSinceEntry = snapshot.recentFills
        .filter(fill => fill.symbol === checkpoint.symbol && fill.side === 'sell'
          && isAuraProductionClientId(fill.clientOrderId) && fill.timestamp >= checkpoint.openedAt)
        .reduce((sum, fill) => sum + fill.quantity, 0);
      if (soldSinceEntry >= checkpoint.quantity * 0.99)
        throw new OwnershipAmbiguityError('Checkpointed AURA position was already sold by an AURA exit; stale checkpoint');
      managed.push({ symbol: checkpoint.symbol, quantity: checkpoint.quantity,
        averageEntryPrice: checkpoint.entryPrice, updatedAt: snapshot.timestamp });
      openedAtBySymbol[checkpoint.symbol] = checkpoint.openedAt;
      protectionPlans[checkpoint.symbol] = { ...checkpoint.protectionPlan,
        initialStopPrice: Math.max(checkpoint.protectionPlan.initialStopPrice, checkpoint.currentStopPrice) };
      protectionModes[checkpoint.symbol] = checkpoint.protectionMode;
      exchangeLinks[checkpoint.symbol] = { entryOrderId: checkpoint.entryOrderId ?? null,
        entryClientOrderId: checkpoint.entryClientOrderId ?? null,
        attachedProtectionIds: [...(checkpoint.attachedProtectionIds ?? [])] };
    }
    const unmanaged = snapshot.positions.flatMap(position => {
      const checkpoint = bySymbol.get(position.symbol);
      if (!checkpoint) return [{ ...position }];
      const remainder = position.quantity - checkpoint.quantity;
      return remainder > quantityTolerance ? [{ symbol: position.symbol, quantity: remainder,
        averageEntryPrice: null, updatedAt: position.updatedAt }] : [];
    });
    return { ...empty(), referencePrices: references, openedAtBySymbol, protectionPlans,
      protectionModes, managedPositions: managed, unmanagedInventory: unmanaged, exchangeLinks };
  }
}
