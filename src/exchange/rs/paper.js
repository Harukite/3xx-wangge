// PaperExchange: simulated trading on top of REAL RISEx prices.
// On init it probes candidate REST endpoints (mainnet first), loads real
// markets, then continuously polls the real mark/last price so the dashboard
// price + candles match the live exchange. Only the order *fills* are
// simulated (matched against the real price path). If no endpoint is
// reachable, it falls back to a synthetic random walk and labels itself so.
import { EventEmitter } from 'node:events';

const FALLBACK_MARKETS = [
  { marketId: 1, displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 61000, stepSize: 0.001, stepPrice: 0.1, maxLeverage: 50, minOrderSize: 0.001 },
  { marketId: 2, displayName: 'ETH-PERP', symbol: 'ETH', lastPrice: 3000, stepSize: 0.001, stepPrice: 0.01, maxLeverage: 50, minOrderSize: 0.001 },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    // Candidate REST bases: explicit override -> mainnet -> testnet.
    this.candidates = [...new Set((opts.apiUrl ? [opts.apiUrl] : []).concat([
      'https://api.risex.trade',       // mainnet (real prices)
      'https://api.rise.trade',        // alt mainnet host
      'https://api.testnet.rise.trade',// testnet fallback
    ]))];
    this.apiUrl = this.candidates[0];
    this.dataSource = 'connecting';   // 'real' | 'synthetic'
    this.network = null;              // 'mainnet' | 'testnet' | null
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.volPerTick = opts.volPerTick ?? 0.0015; // only for synthetic fallback
    this.feeRate = Number(opts.feeRate) || 0.0005; // simulated fee rate per fill
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.prices = new Map();      // displayed/simulated price
    this.realTarget = new Map();  // latest real price target
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
  }

  async init() {
    let chosen = null;
    for (const url of this.candidates) {
      const list = await this._fetchMarkets(url);
      if (list && list.length) { chosen = url; this._setMarkets(list); break; }
    }
    if (chosen) {
      this.apiUrl = chosen;
      this.dataSource = 'real';
      this.network = chosen.includes('testnet') ? 'testnet' : 'mainnet';
    } else {
      this.dataSource = 'synthetic';
      this._setMarkets(FALLBACK_MARKETS.map((m) => ({ ...m })));
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    this._startLoops();           // keep price live even before bot starts
    return true;
  }

  /** Reconnect: re-probe endpoints (upgrades synthetic->real if now reachable) and restart loops. */
  async reconnect() {
    try {
      for (const url of this.candidates) {
        const list = await this._fetchMarkets(url);
        if (list && list.length) {
          this.apiUrl = url;
          this.network = url.includes('testnet') ? 'testnet' : 'mainnet';
          if (this.dataSource !== 'real') { // upgrade only: never re-number live market ids
            this.dataSource = 'real';
            this._setMarkets(list);
            for (const [id, m] of this.markets) { this.prices.set(id, m.lastPrice || 100); this.realTarget.set(id, m.lastPrice || 100); }
          }
          break;
        }
      }
    } catch { /* keep current mode */ }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  async _fetchMarkets(url) {
    try {
      const res = await fetch(`${url}/v1/markets`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const j = await res.json();
      const out = [];
      for (const m of j.markets || []) {
        const cfg = m.config || {};
        const price = Number(m.mark_price || m.last_price || 0);
        if (!price) continue;
        out.push({
          marketId: Number(m.market_id), displayName: m.display_name || cfg.name,
          symbol: m.base_asset_symbol, lastPrice: price,
          stepSize: Number(cfg.step_size || 0.001), stepPrice: Number(cfg.step_price || 0.1),
          maxLeverage: Number(cfg.max_leverage || 20), minOrderSize: Number(cfg.min_order_size || cfg.step_size || 0.001),
        });
      }
      return out.length ? out : null;
    } catch { return null; }
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    if (this.dataSource === 'real') {
      try {
        const now = Date.now() * 1e6, interval = intervalSec * 1e9, from = now - interval * n;
        const url = `${this.apiUrl}/v1/markets/id/${marketId}/trading-view-data?interval=${interval}&from=${from}&to=${now}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          const data = (j.data || []).map((d) => ({
            time: Number(d.time) / 1e6, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume,
          })).filter((c) => Number.isFinite(c.close));
          if (data.length >= 20) return data;
        }
      } catch { /* fall through */ }
    }
    return synthCandles(this.prices.get(marketId) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(marketId); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...o });
    return { orderId: id };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(orderId); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === marketId) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === marketId); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  getPosition(marketId) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(marketId);
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(id);
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
    return true;
  }

  start() { this._startLoops(); }   // no-op if already running
  stop() { /* keep price feed alive across bot stop/start */ }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.();
    }
  }

  async _pollReal() {
    try {
      const res = await fetch(`${this.apiUrl}/v1/markets?force_refresh=true`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return;
      const j = await res.json();
      for (const m of j.markets || []) {
        const id = Number(m.market_id);
        const price = Number(m.mark_price || m.last_price || 0);
        if (price && this.realTarget.has(id)) this.realTarget.set(id, price);
      }
    } catch { /* transient */ }
  }

  _tick() {
    this.lastOkAt = Date.now();
    for (const [id, price] of this.prices) {
      let next;
      if (this.dataSource === 'real') {
        // ease the displayed price toward the latest real target
        const target = this.realTarget.get(id) ?? price;
        next = price + (target - price) * 0.25;
        if (Math.abs(next - target) / target < 1e-5) next = target;
      } else {
        const seed = this.markets.get(id)?.lastPrice || price;
        const drift = (seed - price) / seed * 0.02;
        const shock = (Math.random() * 2 - 1) * this.volPerTick;
        next = Math.max(0.0001, price * (1 + drift + shock));
      }
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, price, next);
    }
  }

  _matchFills(marketId, prev, cur) {
    for (const o of [...this.orders.values()]) {
      if (o.marketId !== marketId) continue;
      const crossedBuy = o.side === 'buy' && cur <= o.price;
      const crossedSell = o.side === 'sell' && cur >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      this._applyFill(marketId, o.side, o.price, o.sizeBase);
      this.emit('fill', { orderId: o.orderId, marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    // Simulate trading fees so paper results don't overstate real performance
    // (the live fee-vs-spacing check reads this.feeRate too, keeping them consistent).
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl; this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) { p.sizeBase = remaining; if (remaining === 0) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}
