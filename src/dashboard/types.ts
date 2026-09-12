import type { AgentStateSnapshot } from '../loop/types.js';
import type {
  EquitySnapshot,
  OpenPosition,
  PerformanceState,
} from '../monitor/types.js';

export interface DashboardSnapshot {
  agent: AgentStateSnapshot;
  equity: EquitySnapshot | null;
  position: OpenPosition | null;
  performance: PerformanceState | null;
}
