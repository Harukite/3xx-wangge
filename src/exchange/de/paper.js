// PaperExchange: simulated trading on top of REAL Decibel prices.
// On init it probes Decibel's REST endpoints (mainnet first), loads real
// markets, then continuously polls real mark/mid prices so the dashboard
// price + candles match the live exchange. Only the order *fills* are
// simulated (matched against the real price path).
//
// NOTE: Decibel's GET API requires a (free) Geomi API key. Set
// DECIBEL_API_KEY in .env to get real prices in paper mode; without it the
// exchange falls back to a synthetic random walk and labels itself so.
import { EventEmitter } from 'node:events';

const FALLBACK_MARKETS = [
  { marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC', lastPrice: 74000, stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001 },
  { marketId: 2, name: 'ETH-USD', displayName: 'ETH-USD', symbol: 'ETH', lastPrice: 2600, stepSize: 0.0001, stepPrice: 0.01, maxLeverage: 50, minOrderSize: 0.001 },
];
const INTERVALS = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 86400: '1d' };

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    this.apiKey = opts.apiKey || '';
    // Candidate REST bases: explicit override -> mainnet -> testnet.
    this.candidates = [...new Set((opts.apiUrl ? [opts.apiUrl] : []).concat([
      'https://api.mainnet.aptoslabs.com/decibel', // mainnet (real prices)
      'https://api.testnet.aptoslabs.com/decibel', // testnet fallback
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
      if (!this.apiKey) console.log('[模拟模式] 未配置 DECIBEL_API_KEY，无法读取 Decibel 真实行情，使用合成行情。在 geomi.dev 免费创建 API key 后填入 .env 即可显示真实价格。');
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

  _headers() {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async _fetchMarkets(url) {
    try {
      const [mres, pres] = await Promise.all([
        fetch(`${url}/api/v1/markets`, { headers: this._headers(), signal: AbortSignal.timeout(8000) }),
        fetch(`${url}/api/v1/prices`, { headers: this._headers(), signal: AbortSignal.timeout(8000) }),
      ]);
      if (!mres.ok || !pres.ok) return null;
      const list = await mres.json();
      const prices = await pres.json();
      if (!Array.isArray(list) || !Array.isArray(prices)) return null;
      const pxByAddr = new Map(prices.map((p) => [String(p.market), p]));
      const out = [];
      let id = 1;
      for (const m of list) {
        if (String(m.mode ?? 'Open') !== 'Open') continue;
        const px = pxByAddr.get(String(m.market_addr));
        const price = Number(px?.mid_px || px?.mark_px || px?.oracle_px || 0);
        if (!price) continue;
        const pxDec = Number(m.px_decimals), szDec = Number(m.sz_decimals);
        out.push({
          marketId: id++, name: m.market_name, displayName: m.market_name,
          symbol: String(m.market_name).split(/[-/]/)[0], lastPrice: price,
          addr: String(m.market_addr),
          stepSize: Number(m.lot_size) / 10 ** szDec, stepPrice: Number(m.tick_size) / 10 ** pxDec,
          maxLeverage: Number(m.max_leverage || 20), minOrderSize: Number(m.min_size) / 10 ** szDec,
        });
      }
      // larger open interest first so BTC/ETH end up on top
      out.sort((a, b) => (pxByAddr.get(b.addr)?.open_interest || 0) - (pxByAddr.get(a.addr)?.open_interest || 0));
      out.forEach((m, i) => { m.marketId = i + 1; });
      return out.length ? out : null;
    } catch { return null; }
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this.markets.get(Number(marketId));
    if (this.dataSource === 'real' && m?.addr) {
      try {
        const interval = INTERVALS[intervalSec] || '1h';
        const end = Date.now();
        const start = end - Math.min(n, 1000) * intervalSec * 1000;
        const url = `${this.apiUrl}/api/v1/candlesticks?market=${encodeURIComponent(m.addr)}&interval=${interval}&startTime=${start}&endTime=${end}`;
        const res = await fetch(url, { headers: this._headers(), signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          const data = (Array.isArray(j) ? j : []).map((c) => ({
            time: Number(c.t ?? c.T), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v ?? 0),
          })).filter((c) => Number.isFinite(c.close)).sort((a, b) => a.time - b.time);
          if (data.length >= 20) return data;
        }
      } catch { /* fall through */ }
    }
    return synthCandles(this.prices.get(Number(marketId)) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...o, marketId: Number(o.marketId) });
    return { orderId: id };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(orderId); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(Number(marketId));
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  /** Close any open position at the current simulated price. */
  async closePosition(marketId) {
    const id = Number(marketId);
    const pos = this.positions.get(id);
    if (!pos || pos.sizeBase === 0) return true;
    const price = this.prices.get(id);
    this._applyFill(id, pos.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(pos.sizeBase));
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
      const res = await fetch(`${this.apiUrl}/api/v1/prices`, { headers: this._headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const j = await res.json();
      const byAddr = new Map((Array.isArray(j) ? j : []).map((p) => [String(p.market), p]));
      for (const [id, m] of this.markets) {
        const px = byAddr.get(m.addr);
        const price = Number(px?.mid_px || px?.mark_px || px?.oracle_px || 0);
        if (price) this.realTarget.set(id, price);
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
