import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StartupExchangeSnapshot } from '../execution/types.js';
import type { OpenPosition, StartupMonitorContext } from '../monitor/types.js';

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
}

const empty = (): StartupMonitorContext => ({ referencePrices: {}, openedAtBySymbol: {},
  protectionPlans: {}, protectionModes: {} });
const positive = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0;

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
      || state.protectionMode !== state.protectionPlan.protectionMode) {
      throw new Error('Invalid AURA recovery checkpoint');
    }
    return state;
  }

  async context(snapshot: StartupExchangeSnapshot, references: Readonly<Record<string, number>>): Promise<StartupMonitorContext> {
    if (snapshot.positions.length === 0) return empty();
    if (snapshot.positions.length !== 1) throw new Error('Multiple exchange positions cannot be recovered');
    const position = snapshot.positions[0]!;
    const checkpoint = await this.load();
    if (!checkpoint || checkpoint.symbol !== position.symbol
      || Math.abs(checkpoint.quantity - position.quantity) > 1e-10
      || !positive(position.averageEntryPrice)
      || Math.abs(checkpoint.entryPrice - position.averageEntryPrice) > 1e-8
      || checkpoint.updatedAt > snapshot.timestamp) {
      throw new Error('Missing or mismatched AURA position recovery checkpoint');
    }
    const plan = { ...checkpoint.protectionPlan,
      initialStopPrice: Math.max(checkpoint.protectionPlan.initialStopPrice, checkpoint.currentStopPrice) };
    return { referencePrices: references, openedAtBySymbol: { [position.symbol]: checkpoint.openedAt },
      protectionPlans: { [position.symbol]: plan }, protectionModes: { [position.symbol]: checkpoint.protectionMode } };
  }
}
