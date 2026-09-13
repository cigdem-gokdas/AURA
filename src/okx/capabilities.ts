import type { OkxToolDefinition } from './types.js';

export type AtkCapability =
  | 'MARKET_TICKER' | 'MARKET_TICKERS' | 'MARKET_CANDLES' | 'MARKET_ORDERBOOK' | 'MARKET_INSTRUMENT'
  | 'ACCOUNT_BALANCE' | 'ACCOUNT_FEE' | 'SPOT_PLACE_ORDER' | 'SPOT_QUERY_ORDER'
  | 'SPOT_QUERY_ORDERS' | 'SPOT_FILLS' | 'SPOT_QUERY_ALGO_ORDERS'
  | 'SPOT_CONDITIONAL_PROTECTION' | 'SPOT_OCO_PROTECTION'
  | 'MARKET_INDICATOR' | 'MARKET_LIST_INDICATORS' | 'MARKET_PAIR_SPREAD'
  | 'NEWS_LATEST' | 'NEWS_SENTIMENT' | 'NEWS_CALENDAR' | 'SYSTEM_CAPABILITIES';

const names: Readonly<Record<AtkCapability, string>> = {
  MARKET_TICKER: 'market_get_ticker', MARKET_TICKERS: 'market_get_tickers', MARKET_CANDLES: 'market_get_candles',
  MARKET_ORDERBOOK: 'market_get_orderbook', MARKET_INSTRUMENT: 'market_get_instruments',
  ACCOUNT_BALANCE: 'account_get_balance', ACCOUNT_FEE: 'account_get_trade_fee',
  SPOT_PLACE_ORDER: 'spot_place_order', SPOT_QUERY_ORDER: 'spot_get_order',
  SPOT_QUERY_ORDERS: 'spot_get_orders', SPOT_FILLS: 'spot_get_fills',
  SPOT_QUERY_ALGO_ORDERS: 'spot_get_algo_orders',
  SPOT_CONDITIONAL_PROTECTION: 'spot_place_algo_order',
  SPOT_OCO_PROTECTION: 'spot_place_algo_order',
  MARKET_INDICATOR: 'market_get_indicator', MARKET_LIST_INDICATORS: 'market_list_indicators',
  MARKET_PAIR_SPREAD: 'market_get_pair_spread', NEWS_LATEST: 'news_get_latest',
  NEWS_SENTIMENT: 'news_get_coin_sentiment', NEWS_CALENDAR: 'news_get_economic_calendar',
  SYSTEM_CAPABILITIES: 'system_get_capabilities',
};
export function canonicalToolName(capability: AtkCapability): string { return names[capability]; }

function supports(definition: OkxToolDefinition, capability: AtkCapability): boolean {
  const props = definition.inputSchema.properties;
  const fields = props && typeof props === 'object' && !Array.isArray(props)
    ? props as Record<string, unknown> : {};
  if (capability === 'SPOT_CONDITIONAL_PROTECTION' || capability === 'SPOT_OCO_PROTECTION') {
    const required = capability === 'SPOT_OCO_PROTECTION'
      ? ['instId', 'side', 'ordType', 'sz', 'tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx']
      : ['instId', 'side', 'ordType', 'sz', 'slTriggerPx', 'slOrdPx'];
    const orderType = fields.ordType;
    const allowed = orderType && typeof orderType === 'object' && !Array.isArray(orderType)
      ? (orderType as { enum?: unknown }).enum : null;
    return required.every(field => field in fields) && Array.isArray(allowed)
      && allowed.includes(capability === 'SPOT_OCO_PROTECTION' ? 'oco' : 'conditional');
  }
  return true;
}

/** Semantic mapping is populated exclusively from one lane's tools/list response. */
export class AtkCapabilityRegistry {
  private readonly mapped = new Map<AtkCapability, OkxToolDefinition>();
  private readonly actualNames = new Set<string>();

  constructor(definitions: readonly OkxToolDefinition[]) {
    for (const definition of definitions) this.actualNames.add(definition.name);
    for (const [semantic, name] of Object.entries(names) as [AtkCapability, string][]) {
      const definition = definitions.find(tool => tool.name === name);
      if (definition && supports(definition, semantic)) this.mapped.set(semantic, definition);
    }
  }

  get toolCount(): number { return this.actualNames.size; }
  has(capability: AtkCapability): boolean { return this.mapped.has(capability); }
  resolve(capability: AtkCapability): string | null { return this.mapped.get(capability)?.name ?? null; }
  reverse(toolName: string): AtkCapability | null {
    return [...this.mapped].find(([, definition]) => definition.name === toolName)?.[0] ?? null;
  }
  names(): readonly string[] { return [...this.actualNames].sort(); }
  missing(capabilities: readonly AtkCapability[]): AtkCapability[] {
    return capabilities.filter(capability => !this.has(capability));
  }
}

export const REQUIRED_READ_CAPABILITIES: readonly AtkCapability[] = [
  'MARKET_TICKER', 'MARKET_TICKERS', 'MARKET_CANDLES', 'MARKET_ORDERBOOK', 'MARKET_INSTRUMENT',
  'ACCOUNT_BALANCE', 'ACCOUNT_FEE', 'SPOT_QUERY_ORDERS', 'SPOT_FILLS',
];
export const REQUIRED_WRITE_CAPABILITIES: readonly AtkCapability[] = ['SPOT_PLACE_ORDER'];
