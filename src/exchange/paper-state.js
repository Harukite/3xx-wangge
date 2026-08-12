// Durable paper-account helpers shared by the three simulated exchanges.
// Numeric market IDs may change whenever a market list is refreshed, so
// positions are serialized with a stable market name and remapped as a unit.

export function snapshotPaperState(exchange) {
  const positions = [];
  for (const [marketId, position] of exchange.positions) {
    if (!position || !Number.isFinite(position.sizeBase) || position.sizeBase === 0) continue;
    positions.push({
      marketName: position.marketName || stableMarketName(exchange.markets.get(Number(marketId))),
      marketId: Number(marketId),
      sizeBase: position.sizeBase,
      entryPrice: position.entryPrice,
    });
  }
  return {
    version: 1,
    balance: exchange.balance,
    realizedPnl: exchange.realizedPnl,
    positions,
    seq: exchange._seq,
  };
}

export function restorePaperState(exchange, state) {
  const positions = new Map();
  for (const saved of state.positions) {
    const market = findUniqueMarket(exchange.markets, saved.marketName);
    if (!market) throw new Error(`无法把模拟仓位 ${saved.marketName} 映射到当前市场列表`);
    const marketId = Number(market.marketId);
    if (positions.has(marketId)) throw new Error(`多个模拟仓位映射到了同一 marketId=${marketId}`);
    positions.set(marketId, {
      sizeBase: saved.sizeBase,
      entryPrice: saved.entryPrice,
      marketName: stableMarketName(market),
    });
  }
  // Commit only after every market was resolved, so a partial restore can never
  // overwrite a valid in-memory ledger.
  exchange.balance = state.balance;
  exchange.realizedPnl = state.realizedPnl;
  exchange.positions = positions;
  exchange._seq = state.seq;
}

export function replacePaperMarkets(exchange, list) {
  const nextMarkets = new Map(list.map((market) => [Number(market.marketId), market]));
  const nextPositions = new Map();
  const nextOrders = new Map();

  for (const [oldId, position] of exchange.positions) {
    if (!position || position.sizeBase === 0) continue;
    const oldName = position.marketName || stableMarketName(exchange.markets.get(Number(oldId)));
    const market = findUniqueMarket(nextMarkets, oldName);
    if (!market) throw new Error(`行情重连后找不到模拟仓位市场 ${oldName || oldId}`);
    const newId = Number(market.marketId);
    if (nextPositions.has(newId)) throw new Error(`行情重连后多个模拟仓位映射到了 marketId=${newId}`);
    nextPositions.set(newId, { ...position, marketName: stableMarketName(market) });
  }

  for (const [orderId, order] of exchange.orders) {
    const oldMarket = exchange.markets.get(Number(order.marketId));
    const market = findUniqueMarket(nextMarkets, stableMarketName(oldMarket));
    if (!market) throw new Error(`行情重连后找不到模拟挂单市场 ${stableMarketName(oldMarket) || order.marketId}`);
    nextOrders.set(orderId, { ...order, marketId: Number(market.marketId) });
  }

  // Replace all ID-keyed state together; sequential one-ID-at-a-time moves can
  // overwrite another position when two markets swap numeric IDs.
  exchange.markets = nextMarkets;
  exchange.positions = nextPositions;
  exchange.orders = nextOrders;
  exchange.prices = new Map(list.map((market) => [Number(market.marketId), Number(market.lastPrice) || 100]));
  exchange.realTarget = new Map(exchange.prices);
}

export function remapPaperMarket(exchange, from, to) {
  const oldId = Number(from), newId = Number(to);
  if (oldId === newId) return;
  const position = exchange.positions.get(oldId);
  if (position) {
    if (exchange.positions.has(newId)) {
      throw new Error(`拒绝把 marketId=${oldId} 的模拟仓位覆盖到已有仓位 marketId=${newId}`);
    }
    const market = exchange.markets.get(newId);
    exchange.positions.set(newId, { ...position, marketName: stableMarketName(market) || position.marketName });
    exchange.positions.delete(oldId);
  }
  for (const order of exchange.orders.values()) {
    if (Number(order.marketId) === oldId) order.marketId = newId;
  }
}

export function stableMarketName(market) {
  return String(market?.displayName || market?.name || market?.symbol || '').trim();
}

function findUniqueMarket(markets, name) {
  const wanted = normalizeMarketName(name);
  if (!wanted) return null;
  const matches = [...markets.values()].filter((market) => [market.displayName, market.name, market.symbol]
    .some((candidate) => normalizeMarketName(candidate) === wanted));
  const ids = new Set(matches.map((market) => Number(market.marketId)));
  return ids.size === 1 ? matches[0] : null;
}

function normalizeMarketName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
