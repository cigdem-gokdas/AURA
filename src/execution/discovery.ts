import type { OkxToolDefinition } from '../okx/types.js';
import { OkxConnectorError } from '../okx/types.js';

export interface ExecutionTools {
  placeOrder: string;
  getOrder: string | null;
  getOrders: string | null;
  getFills: string | null;
  getAlgoOrders: string | null;
  placeAlgoOrder: string | null;
  conditionalProtectionSupported: boolean;
  ocoProtectionSupported: boolean;
  getBalance: string | null;
  getTradeFee: string | null;
  clientOrderIdSupported: boolean;
  attachedProtectionSupported: boolean;
}

function properties(tool: OkxToolDefinition | undefined): Record<string, unknown> {
  const value = tool?.inputSchema.properties;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function has(tool: OkxToolDefinition | undefined, ...fields: string[]): boolean {
  const props = properties(tool);
  return tool !== undefined && fields.every(field => field in props);
}

function allows(tool: OkxToolDefinition | undefined, field: string, choice: string): boolean {
  const property = properties(tool)[field];
  if (!property || typeof property !== 'object' || Array.isArray(property)) return false;
  const values = (property as Record<string, unknown>).enum;
  return Array.isArray(values) && values.includes(choice);
}

/** Map only names and schemas actually returned by this connector session. */
export function discoverExecutionTools(definitions: readonly OkxToolDefinition[]): ExecutionTools {
  const byName = new Map(definitions.map(tool => [tool.name, tool]));
  const place = byName.get('spot_place_order');
  if (!has(place, 'instId', 'tdMode', 'side', 'ordType', 'sz', 'tgtCcy', 'clOrdId')
    || !allows(place, 'tdMode', 'cash') || !allows(place, 'side', 'buy')
    || !allows(place, 'side', 'sell') || !allows(place, 'ordType', 'market')
    || !allows(place, 'tgtCcy', 'base_ccy')) {
    throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'Compatible spot place-order schema unavailable');
  }
  const getOrder = byName.get('spot_get_order');
  const getOrders = byName.get('spot_get_orders');
  const getFills = byName.get('spot_get_fills');
  const getAlgoOrders = byName.get('spot_get_algo_orders');
  const placeAlgoOrder = byName.get('spot_place_algo_order');
  const getBalance = byName.get('account_get_balance');
  const getTradeFee = byName.get('account_get_trade_fee');
  return {
    placeOrder: place!.name,
    getOrder: has(getOrder, 'instId', 'clOrdId') ? getOrder!.name : null,
    getOrders: has(getOrders, 'status', 'instId') ? getOrders!.name : null,
    getFills: has(getFills, 'instId') ? getFills!.name : null,
    getAlgoOrders: has(getAlgoOrders, 'status', 'instId') ? getAlgoOrders!.name : null,
    placeAlgoOrder: has(placeAlgoOrder, 'instId', 'side', 'ordType', 'sz') ? placeAlgoOrder!.name : null,
    conditionalProtectionSupported: has(placeAlgoOrder, 'instId', 'side', 'ordType', 'sz', 'slTriggerPx', 'slOrdPx')
      && allows(placeAlgoOrder, 'ordType', 'conditional'),
    ocoProtectionSupported: has(placeAlgoOrder, 'instId', 'side', 'ordType', 'sz', 'tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx')
      && allows(placeAlgoOrder, 'ordType', 'oco'),
    getBalance: getBalance?.name ?? null,
    getTradeFee: has(getTradeFee, 'instType', 'instId') ? getTradeFee!.name : null,
    clientOrderIdSupported: true,
    attachedProtectionSupported: has(place, 'tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx'),
  };
}
