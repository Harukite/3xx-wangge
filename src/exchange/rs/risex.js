// RisexExchange: LIVE adapter over the community `risex-client` SDK (v0.1.x).
// Verified against the installed SDK's real API:
//   InfoClient(opts?:{baseUrl,wsUrl}) . getMarkets/getOrderbook/getPosition/
//     getOpenOrders/getBalance/getRealizedPnl/getCandles
//   ExchangeClient({account,signerKey,baseUrl,wsUrl}) . init/placeOrder/
//     cancelOrder/cancelAllOrders/updateLeverage/closePosition
//
// Fills are detected by POLLING open orders (an order we placed that is no
// longer resting = filled). This avoids the WebSocket private-channel auth
// dance and is robust for a grid bot. Position / balance / realized PnL and the
// mark price are polled on the same loop.
//
// NOTE: `risex-client` is UNOFFICIAL and ships TESTNET defaults; it has no
// built-in mainnet REST URL. Real-money mainnet requires a working mainnet
// REST endpoint via RISEX_API_URL. Always validate on testnet first.
import { EventEmitter } from 'node:events';

export class RisexExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.account = opts.account;
    this.signerKey = opts.signerKey;
    this.baseUrl = opts.apiUrl;   // maps to SDK `baseUrl`
    this.wsUrl = opts.wsUrl;
    this.pollMs = opts.pollMs ?? 2500;
    this._graceMs = this.pollMs * 2; // grace before judging a just-placed order "gone"
    this.lastOkAt = 0;
    this.lastError = null;
    this.markets = new Map();
    this.balance = null;
    this.realizedPnl = null;
    this._info = null;
    this._client = null;
    this._tracked = new Map(); // order_id -> {levelIndex, side, price, sizeBase, seen}
    this._watch = new Set();   // marketIds to poll
    this._watchTouch = new Map(); // marketId -> last external interest (for idle pruning)
    this._pos = new Map();     // marketId -> {sizeBase, entryPrice, unrealizedPnl}
    this._prices = new Map();
    this._timer = null;
    this._busy = false;
    this._txQueue = Promise.resolve(); // serialize on-chain txs (permit nonce is sequential)
  }

  // RISEx orders are on-chain EIP-712 permits with a SEQUENTIAL nonce. Firing them
  // concurrently makes two txs grab the same nonce -> `NonceUsed` / reverted.
  // Run every state-changing SDK call one-at-a-time through this queue.
  _serial(fn) {
    const run = this._txQueue.then(fn, fn);
    this._txQueue = run.then(() => {}, () => {});
    return run;
  }

  async init() {
    let SDK;
    try { SDK = await import('risex-client'); }
    catch (e) { throw new Error('未安装 risex-client，请先 npm install。原始错误：' + e.message); }
    const { InfoClient, ExchangeClient } = SDK;
    const opts = {};
    if (this.baseUrl) opts.baseUrl = this.baseUrl;
    if (this.wsUrl) opts.wsUrl = this.wsUrl;
    this._info = new InfoClient(opts);
    this._client = new ExchangeClient({ account: this.account, signerKey: this.signerKey, ...opts });
    await this._client.init(); // fetches EIP-712 domain + contract addresses

    const markets = await this._info.getMarkets();
    for (const m of markets) {
      const cfg = m.config || {};
      this.markets.set(Number(m.market_id), {
        marketId: Number(m.market_id), displayName: m.display_name || cfg.name,
        symbol: m.base_asset_symbol, lastPrice: Number(m.mark_price || m.last_price || 0),
        stepSize: Number(cfg.step_size), stepPrice: Number(cfg.step_price),
        maxLeverage: Number(cfg.max_leverage || 20), minOrderSize: Number(cfg.min_order_size || cfg.step_size),
      });
      this._prices.set(Number(m.market_id), Number(m.mark_price || m.last_price || 0));
    }
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.network = (this.baseUrl || '').includes('testnet') ? 'testnet' : 'mainnet';
    this.apiUrl = this.baseUrl; // for logging/UI
    const first = this.markets.keys().next().value;
    if (first != null) this._watch.add(Number(first));
    await this._refreshAccount().catch(() => {});
    this.start(); // begin background polling so account/price populate immediately
    return true;
  }

  /**
   * Re-establish the exchange connection WITHOUT touching resting orders or the
   * position: rebuild the SDK clients (fresh EIP-712 domain / HTTP state), drop
   * a possibly-wedged tx queue, break a stuck poll lock, probe the account, and
   * restart polling. Order tracking is preserved. Throws if still unreachable.
   */
  async reconnect() {
    this.stop();          // clear the poll timer
    this._busy = false;   // break a poll wedged on a hung request
    this.lastError = null;
    if (!this._info || !this.markets.size) return this.init(); // never came up: full init
    const SDK = await import('risex-client');
    const opts = {};
    if (this.baseUrl) opts.baseUrl = this.baseUrl;
    if (this.wsUrl) opts.wsUrl = this.wsUrl;
    this._info = new SDK.InfoClient(opts);
    this._client = new SDK.ExchangeClient({ account: this.account, signerKey: this.signerKey, ...opts });
    await this._client.init();
    this._txQueue = Promise.resolve(); // discard a wedged serialization chain
    const b = await this._info.getBalance(this.account); // probe: throws if still down
    if (b != null) this.balance = Number(b);
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    // 用 V2 接口（旧的 /v1/markets/trading-view-data 在主网返回 NotFound）。
    // 参数单位均为纳秒；返回 { data:[{ time(ns), open, high, low, close, volume }] }
    const interval = Math.round(intervalSec * 1e9);
    const to = Date.now() * 1e6;          // ms -> ns
    const from = to - interval * n;
    const base = this.baseUrl || 'https://api.rise.trade';
    const url = `${base}/v1/markets/id/${marketId}/trading-view-data?interval=${interval}&from=${from}&to=${to}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const j = await res.json();
      const arr = Array.isArray(j.data) ? j.data : (j.data && j.data.data) || (j.data && j.data.candles) || [];
      return arr.map((c) => ({
        time: Number(c.time) / 1e6,        // ns -> ms
        open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0),
      })).filter((c) => Number.isFinite(c.close));
    } catch { return []; }
  }
  async getPrice(marketId, opts = {}) {
    this._watch.add(Number(marketId));
    if (opts.touch !== false) this._watchTouch.set(Number(marketId), Date.now()); // external interest
    try {
      const book = await this._info.getOrderbook(marketId);
      const bid = Number(book.bids?.[0]?.[0] ?? book.bids?.[0]?.price);
      const ask = Number(book.asks?.[0]?.[0] ?? book.asks?.[0]?.price);
      if (bid && ask) { const mid = (bid + ask) / 2; this._prices.set(Number(marketId), mid); return mid; }
    } catch { /* fall back only when a fresh quote was not required */ }
    if (opts.requireFresh) return null;
    return this._prices.get(Number(marketId)) ?? this.markets.get(Number(marketId))?.lastPrice;
  }

  async setLeverage(marketId, x) {
    try { return await this._client.updateLeverage(Number(marketId), BigInt(Math.round(x))); }
    catch (e) { this.emit('error', e); return false; }
  }

  _steps(marketId, base) { return Math.max(1, Math.round(base / this.markets.get(Number(marketId)).stepSize)); }
  _ticks(marketId, price) { return Math.round(price / this.markets.get(Number(marketId)).stepPrice); }

  async placeLimitOrder(o) {
    const mId = Number(o.marketId);
    const priceUsed = this._ticks(mId, o.price) * this.markets.get(mId).stepPrice;
    const sizeUsed = this._steps(mId, o.sizeBase) * this.markets.get(mId).stepSize;
    const r = await this._serial(() => this._client.placeOrder({
      market_id: mId,
      side: o.side === 'buy' ? 0 : 1,
      order_type: 1,            // Limit
      price_ticks: this._ticks(mId, o.price),
      size_steps: this._steps(mId, o.sizeBase),
      time_in_force: 0,         // GTC
      // post_only MUST default to false here: RISEx has no order-status endpoint,
      // so a post-only order silently rejected for crossing simply never appears
      // in the open-order list — and the poll-based fill detector would then
      // fabricate a phantom "fill" for it. GTC crossing just fills as taker.
      post_only: o.postOnly ?? false,
      reduce_only: !!o.reduceOnly,
      stp_mode: 0,
      ttl_units: 0,
      client_order_id: o.clientOrderId ? String(o.clientOrderId) : undefined,
    }));
    const orderId = r.order_id || r.orderId;
    if (orderId) {
      this._watch.add(mId);
      this._tracked.set(String(orderId), {
        marketId: mId, levelIndex: o.levelIndex, side: o.side,
        price: priceUsed, sizeBase: sizeUsed, reduceOnly: !!o.reduceOnly,
        seen: false, placedAt: Date.now(),
      });
    }
    return { orderId, priceUsed, sizeUsed };
  }

  async cancelOrder(marketId, orderId) {
    const result = await this._serial(() => this._client.cancelOrder({ market_id: Number(marketId), order_id: String(orderId) }));
    if (result?.success !== true) return false;
    this._tracked.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    try {
      const result = await this._serial(() => this._client.cancelAllOrders(Number(marketId)));
      if (result?.success !== true) return false;
      for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this._tracked.delete(id);
      return true;
    }
    catch (e) { this.emit('error', e); return false; }
  }

  getOpenOrders(marketId) {
    return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId));
  }

  /** REAL resting orders on the exchange for this market (for reconciliation). */
  async fetchOpenOrders(marketId) {
    const mId = Number(marketId);
    const market = this.markets.get(mId);
    const open = await this._info.getOpenOrders(this.account, mId);
    if (!Array.isArray(open)) return null;
    return open.map((o) => {
      const side = (typeof o.side === 'number')
        ? (o.side === 0 ? 'buy' : (o.side === 1 ? 'sell' : null))
        : (/^(0|buy|long)$/i.test(String(o.side)) ? 'buy'
          : (/^(1|sell|short)$/i.test(String(o.side)) ? 'sell' : null));
      const reduceOnly = typeof o.reduce_only === 'boolean' ? o.reduce_only : null;
      const ticks = Number(o.price_ticks);
      const steps = Number(o.size_steps);
      const price = Number.isFinite(ticks) && Number.isFinite(market?.stepPrice) && market.stepPrice > 0
        ? ticks * market.stepPrice : null;
      // The SDK's open-order shape exposes total encoded size_steps but not a
      // documented remaining quantity. A partially filled OPEN order therefore
      // cannot be proven equal to the persisted remainder from this endpoint.
      const sizeBase = null;
      const metadataComplete = !!o.order_id && ['buy', 'sell'].includes(side)
        && Number.isFinite(price) && price > 0 && Number.isFinite(sizeBase) && sizeBase > 0
        && typeof reduceOnly === 'boolean';
      return {
        orderId: String(o.order_id), price, side, sizeBase,
        reduceOnly, metadataComplete,
      };
    });
  }

  /** Re-attach a previously-placed order to this adapter's tracking (resume). */
  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, reduceOnly = false }) {
    const mId = Number(marketId);
    this._watch.add(mId);
    this._tracked.set(String(orderId), {
      marketId: mId, levelIndex, side, price: Number(price), sizeBase: Number(sizeBase),
      reduceOnly: !!reduceOnly, seen: false, placedAt: Date.now(),
    });
  }

  getPosition(marketId) {
    const p = this._pos.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  async refreshPosition(marketId) {
    const mId = Number(marketId);
    const p = await this._info.getPosition(mId, this.account);
    if (!p || !Number(p.size)) {
      this._pos.delete(mId);
      return null;
    }
    const short = (typeof p.side === 'number') ? p.side === 1 : /^(1|short|sell)$/i.test(String(p.side));
    const size = Math.abs(Number(p.size)) * (short ? -1 : 1);
    const num = (value) => (value != null && value !== '' && Number.isFinite(Number(value))) ? Number(value) : NaN;
    let entry = num(p.avg_entry_price) || num(p.entry_price) || num(p.average_entry_price);
    if (!(entry > 0)) {
      const quote = num(p.quote_amount);
      if (Number.isFinite(quote) && Math.abs(size) > 0) entry = Math.abs(quote) / Math.abs(size);
    }
    entry = entry > 0 ? entry : 0;
    const mark = num(p.mark_price) || this._prices.get(mId) || entry;
    let unrealizedPnl = num(p.unrealized_pnl);
    if (!Number.isFinite(unrealizedPnl)) unrealizedPnl = entry > 0 && mark > 0 ? size * (mark - entry) : 0;
    const position = { sizeBase: size, entryPrice: entry, unrealizedPnl, leverage: num(p.leverage) || null };
    this._pos.set(mId, position);
    return position;
  }

  async closePosition(marketId) {
    const mId = Number(marketId);
    const p = await this._info.getPosition(mId, this.account);
    if (!p) return true;
    const size = Number(p.size);
    if (p.size == null || p.size === '' || !Number.isFinite(size)) throw new Error('RISEx 持仓数量无效，拒绝提交平仓单。');
    if (size === 0) return true;
    const side = String(p.side).toLowerCase();
    if (!['0', '1', 'long', 'short', 'buy', 'sell'].includes(side)) {
      throw new Error('RISEx 持仓方向无效，拒绝提交平仓单。');
    }
    const short = /^(1|short|sell)$/.test(side);
    return this._serial(() => this._client.placeOrder({
      market_id: mId,
      side: short ? 0 : 1,
      order_type: 0,           // Market
      price_ticks: 0,
      size_steps: this._steps(mId, Math.abs(size)),
      time_in_force: 3,        // IOC
      post_only: false,
      reduce_only: true,
      stp_mode: 0,
      ttl_units: 0,
    }));
  }

  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._busy) {
      // Watchdog: a poll wedged >90s would block polling forever ("数据 Xs 未更新").
      if (Date.now() - (this._busySince || 0) < 90_000) return;
      console.log('[RISEx] ⚠ 上一轮轮询卡住超过 90 秒，强制解锁继续轮询。');
    }
    this._busy = true; this._busySince = Date.now();
    try {
      // prune idle watch entries: no resting orders, no position, and no external
      // price interest for 10 minutes -> stop polling that market
      const nowT = Date.now();
      for (const mId of [...this._watch]) {
        const hasOrders = [...this._tracked.values()].some((t) => t.marketId === mId);
        if (!hasOrders && !this._pos.has(mId) && nowT - (this._watchTouch.get(mId) || 0) > 600_000) {
          this._watch.delete(mId); this._watchTouch.delete(mId);
        }
      }
      for (const mId of this._watch) {
        // price (awaited so we can record each tracked order's observed range)
        let px = null;
        try { px = await this.getPrice(mId, { touch: false }); } catch { /* keep */ }
        if (px) {
          this.emit('price', { marketId: mId, price: px });
          // record the price range each tracked order has lived through — used
          // below to corroborate "vanished order = fill"
          for (const t of this._tracked.values()) {
            if (t.marketId !== mId) continue;
            t.pxLo = t.pxLo != null ? Math.min(t.pxLo, px) : px;
            t.pxHi = t.pxHi != null ? Math.max(t.pxHi, px) : px;
          }
        }
        // open orders -> fill detection
        let open;
        try { open = await this._info.getOpenOrders(this.account, mId); } catch { open = null; }
        if (open) {
          const liveIds = new Set(open.map((o) => String(o.order_id)));
          for (const o of open) { const t = this._tracked.get(String(o.order_id)); if (t) { t.seen = true; t.goneAttempts = 0; } }
          const now = Date.now();
          for (const [id, t] of [...this._tracked]) {
            if (t.marketId !== mId || liveIds.has(id)) continue;
            if (!t.seen && now - (t.placedAt || 0) < this._graceMs) continue;
            if (t.resolving) continue;
            t.resolving = true;
            this._resolveGone(id, t).finally(() => { t.resolving = false; });
          }
        }
        // position
        try {
          const p = await this._info.getPosition(mId, this.account);
          if (p && Number(p.size)) {
            const short = (typeof p.side === 'number') ? p.side === 1 : /^(1|short|sell)$/i.test(String(p.side));
            const size = Math.abs(Number(p.size)) * (short ? -1 : 1);
            // RISEx mainnet returns avg_entry_price / mark_price / unrealized_pnl as
            // BLANK strings; only `quote_amount` (signed quote cost) is populated.
            // Derive the missing pieces:
            //   entry ≈ |quote_amount| / |size| ; mark = orderbook mid ; uPnl = size*(mark-entry)
            const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : NaN;
            let entry = num(p.avg_entry_price) || num(p.entry_price) || num(p.average_entry_price);
            if (!(entry > 0)) {
              const qa = num(p.quote_amount), sz = Math.abs(Number(p.size));
              if (Number.isFinite(qa) && sz > 0) entry = Math.abs(qa) / sz;
            }
            entry = entry > 0 ? entry : 0;
            const mark = num(p.mark_price) || this._prices.get(mId) || entry;
            let uPnl = num(p.unrealized_pnl);
            if (!Number.isFinite(uPnl)) uPnl = (entry > 0 && mark > 0) ? size * (mark - entry) : 0;
            const lev = num(p.leverage) || null;
            this._pos.set(mId, { sizeBase: size, entryPrice: entry, unrealizedPnl: uPnl, leverage: lev });
          } else { this._pos.delete(mId); }
        } catch { /* keep last */ }
      }
      await this._refreshAccount();
      this.lastOkAt = Date.now();
    } catch (e) { this.lastError = e?.message || String(e); this.emit('error', e); }
    finally { this._busy = false; }
  }

  async _resolveGone(id, t) {
    let verdict = 'unknown';
    let fillPrice = t.price, fillSize = t.sizeBase;
    let matches = [], order = null;
    let historyExhaustive = true;
    try {
      const fills = await this._info.getAccountTradeHistory(this.account, t.marketId, 200);
      if (!Array.isArray(fills)) historyExhaustive = false;
      const rows = Array.isArray(fills) ? fills : [];
      matches = rows.filter((row) => String(row.order_id) === String(id));
      if (!matches.length && rows.length >= 200) historyExhaustive = false;
    } catch { historyExhaustive = false; }
    try {
      const history = await this._info.getOrderHistory(this.account, t.marketId, 200);
      if (!Array.isArray(history)) historyExhaustive = false;
      const rows = Array.isArray(history) ? history : [];
      order = rows.find((row) => String(row.order_id) === String(id)) || null;
      if (!order && rows.length >= 200) historyExhaustive = false;
    } catch { historyExhaustive = false; }

    const status = String(order?.status || '');
    if (/open|new|resting|pending|acknowledged|partial/i.test(status)) {
      t.goneAttempts = 0;
      t.seen = true;
      return;
    }
    const totals = matches.reduce((acc, fill) => {
      const size = Number(fill.size);
      const price = Number(fill.price);
      if (size > 0) {
        acc.size += size;
        if (price > 0) acc.notional += size * price;
      }
      return acc;
    }, { size: 0, notional: 0 });
    if (totals.size > 0) {
      verdict = 'filled';
      fillSize = totals.size;
      if (totals.notional > 0) fillPrice = totals.notional / totals.size;
    } else if (order) {
      const filled = Number(order.filled_size ?? 0);
      if (filled > 0 || /fill|filled|matched|closed/i.test(status)) {
        verdict = 'filled';
        if (filled > 0) fillSize = filled;
        const price = Number(order.price);
        if (price > 0) fillPrice = price;
      } else if (/cancel|reject|expire/i.test(status)) verdict = 'cancelled';
    }

    if (verdict === 'unknown') {
      t.goneAttempts = (t.goneAttempts || 0) + 1;
      if (t.goneAttempts < 12 || !historyExhaustive) return;
      verdict = 'cancelled';
    }
    this._tracked.delete(String(id));
    if (verdict === 'filled') {
      this.emit('fill', { orderId: String(id), marketId: t.marketId, side: t.side, price: fillPrice, sizeBase: fillSize, levelIndex: t.levelIndex });
    } else {
      this.emit('error', new Error(`订单 ${id}（${t.side} @ ${t.price}）未能通过 RISEx 账户历史确认成交，已停止跟踪（不补单）。`));
    }
  }

  async _refreshAccount() {
    try { const b = await this._info.getBalance(this.account); if (b != null) { this.balance = Number(b); this.lastOkAt = Date.now(); } } catch { /* keep */ }
    try { const r = await this._info.getRealizedPnl(this.account); if (r?.total_realized_pnl != null) this.realizedPnl = Number(r.total_realized_pnl); } catch { /* keep */ }
  }
}
