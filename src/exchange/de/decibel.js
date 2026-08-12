// DecibelExchange: LIVE adapter for Decibel (https://decibel.trade), a fully
// on-chain perpetuals DEX on Aptos.
//
// Unlike a normal CEX-style REST API, every order/cancel on Decibel is an
// Aptos transaction signed with your (API-)wallet's Ed25519 key. This adapter
// uses the official SDKs (loaded lazily so paper mode stays dependency-free):
//   - @decibeltrade/sdk  : DecibelReadDex (market/account data) +
//                          DecibelWriteDex (signed order transactions)
//   - @aptos-labs/ts-sdk : key handling / object address derivation
//
// Markets are addressed by NAME ("BTC-USD") and an on-chain object address.
// The bot uses numeric marketIds, so this adapter assigns stable per-process
// ids and keeps name + address on the market object.
//
// Fills are detected by polling open orders (the same strategy as before):
// a tracked order that is no longer resting is looked up in order history;
// if it wasn't cancelled/rejected it is reported as a fill.
import { EventEmitter } from 'node:events';

export const NETWORKS = {
  mainnet: {
    aptosNetwork: 'mainnet',
    fullnodeUrl: 'https://api.mainnet.aptoslabs.com/v1',
    tradingHttpUrl: 'https://api.mainnet.aptoslabs.com/decibel',
    tradingWsUrl: 'wss://api.mainnet.aptoslabs.com/decibel/ws',
    package: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06',
    // Circle native USDC (FA metadata) on Aptos mainnet. Only used by the SDK
    // for deposit/withdraw helpers, which this bot never calls.
    usdc: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  },
  testnet: {
    aptosNetwork: 'testnet',
    fullnodeUrl: 'https://api.testnet.aptoslabs.com/v1',
    tradingHttpUrl: 'https://api.testnet.aptoslabs.com/decibel',
    tradingWsUrl: 'wss://api.testnet.aptoslabs.com/decibel/ws',
    package: '0xe7da2794b1d8af76532ed95f38bfdf1136abfd8ea3a240189971988a83101b7f',
    usdc: '0x0', // resolved by the SDK preset when available
  },
};

// bot intervalSec -> Decibel candlestick interval string
const INTERVALS = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 86400: '1d' };

// ---------- pure helpers (exported for tests) ----------

/** Convert a decimal price to integer chain units snapped to tick_size. */
export function toChainPrice(price, m) {
  const raw = price * 10 ** m.pxDecimals;
  const ticks = Math.max(1, Math.round(raw / m.tickSize));
  return ticks * m.tickSize;
}

/** Convert a decimal size to integer chain units snapped DOWN to lot_size. */
export function toChainSize(size, m) {
  const raw = size * 10 ** m.szDecimals;
  const lots = Math.floor(raw / m.lotSize + 1e-9); // epsilon absorbs float error
  return lots * m.lotSize;
}

export function fromChainPrice(chain, m) { return chain / 10 ** m.pxDecimals; }
export function fromChainSize(chain, m) { return chain / 10 ** m.szDecimals; }

/** Pick the first present, finite numeric field from an object (API tolerance). */
export function pickNum(obj, ...keys) {
  for (const k of keys) {
    const raw = obj?.[k];
    if (raw == null || raw === '') continue; // null/undefined are "absent", not 0
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

export class DecibelExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.network = opts.network === 'testnet' ? 'testnet' : 'mainnet';
    this.net = NETWORKS[this.network];
    this.apiKey = opts.apiKey;                 // Geomi API key (read + fullnode auth)
    this.privateKey = opts.privateKey;         // Ed25519 hex (API wallet)
    this.subaccount = opts.subaccount || null; // trading account address
    this.apiUrl = opts.apiUrl || this.net.tradingHttpUrl;
    this.pollMs = opts.pollMs ?? 2000;            // 更快轮询以降低链上索引器滞后
    this.cancelConfirmDelayMs = opts.cancelConfirmDelayMs ?? 400;
    this.cancelConfirmAttempts = opts.cancelConfirmAttempts ?? 12;
    this._graceMs = this.pollMs * 2; // give a just-placed order time to be indexed before judging it "gone"
    this.lastOkAt = 0;               // 上次成功轮询时间（健康检测用）
    this.lastError = null;
    this.markets = new Map();   // marketId -> market
    this.balance = null;
    this.equity = null;
    this._tracked = new Map();  // orderId(str) -> {marketId, levelIndex, side, price, sizeBase, seen}
    this._watch = new Set();
    this._watchTouch = new Map(); // marketId -> last external interest (for idle pruning)
    this._pos = new Map();
    this._prices = new Map();
    this._pxStale = new Set();   // markets whose direct feed looks frozen (风控改用持仓推算价)
    this._byAddr = new Map();   // market_addr -> market
    this._timer = null;
    this._busy = false;
    this.read = null;
    this.write = null;
  }

  async init() {
    if (!this.apiKey || !this.privateKey) {
      throw new Error('LIVE 模式需要 DECIBEL_API_KEY（geomi.dev 创建）和 DECIBEL_PRIVATE_KEY（app.decibel.trade/api 的 API 钱包私钥）。');
    }
    let sdk, aptos;
    try {
      // The SDK ships ESM compiled by plain tsc: its relative imports have no
      // file extensions, which Node can't resolve natively. Register a resolve
      // hook that retries with .js / /index.js before importing it.
      if (!globalThis.__decibelEsmHooks) {
        const { register } = await import('node:module');
        register('./esm-hooks.js', import.meta.url);
        globalThis.__decibelEsmHooks = true;
      }
      sdk = await import('@decibeltrade/sdk');
      aptos = await import('@aptos-labs/ts-sdk');
    } catch (e) {
      throw new Error('未安装 Decibel SDK 依赖，请先在项目目录运行 npm install。底层错误: ' + e.message);
    }
    const { DecibelReadDex, DecibelWriteDex } = sdk;
    const { Ed25519Account, Ed25519PrivateKey, AccountAddress, createObjectAddress, Network } = aptos;

    // Prefer an SDK preset if this version ships one for our network;
    // otherwise assemble the documented config by hand.
    const preset = this.network === 'mainnet'
      ? (sdk.MAINNET_CONFIG || null)
      : (sdk.TESTNET_CONFIG || null);
    const pkg = preset?.deployment?.package || this.net.package;
    const perpEngineGlobal = preset?.deployment?.perpEngineGlobal
      || createObjectAddress(AccountAddress.fromString(pkg), 'GlobalPerpEngine').toString();
    const config = preset || {
      network: this.network === 'mainnet' ? Network.MAINNET : Network.TESTNET,
      fullnodeUrl: this.net.fullnodeUrl,
      tradingHttpUrl: this.apiUrl,
      tradingWsUrl: this.net.tradingWsUrl,
      deployment: { package: pkg, usdc: this.net.usdc, testc: this.net.usdc, perpEngineGlobal },
    };

    this.account = new Ed25519Account({ privateKey: new Ed25519PrivateKey(this.privateKey) });
    if (!this.subaccount) {
      throw new Error('请在 .env 配置 DECIBEL_SUBACCOUNT（app.decibel.trade 账户页的 Trading Account 地址）。');
    }
    this.TimeInForce = sdk.TimeInForce || { GoodTillCanceled: 0, PostOnly: 1, ImmediateOrCancel: 2 };
    this.read = new DecibelReadDex(config, { nodeApiKey: this.apiKey, onWsError: () => {} });
    // skipSimulate: the SDK's pre-submit simulation doubles the *estimated
    // maximum* gas, which on mainnet exceeds the chain's per-tx gas bound and
    // gets every order rejected (MAX_GAS_UNITS_EXCEEDS_MAX_GAS_UNITS_BOUND).
    // Without simulation the tx uses the SDK default max gas, well within the
    // bound and plenty for an order.
    this.write = new DecibelWriteDex(config, this.account, { nodeApiKey: this.apiKey, skipSimulate: true });
    this._sdk = sdk; this._sdkConfig = config; // kept for reconnect(): rebuild clients without restart

    // Transient resets (flaky proxy nodes etc.) shouldn't kill startup: retry.
    await this._retry(() => this._loadMarkets(), 'markets 列表');
    if (!this.markets.size) throw new Error('Decibel 未返回可交易市场。');
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    await this._retry(() => this._refreshAccount(), '账户信息'); // also validates the API key / subaccount
    this.start();
    return true;
  }

  /**
   * Re-establish the exchange connection WITHOUT touching resting orders or the
   * position: rebuild the SDK read/write clients (discarding any wedged internal
   * HTTP/WS state), break a stuck poll lock, probe the account once, and restart
   * polling. Order tracking (_tracked/_watch/_pos) is preserved so the grid
   * carries on exactly where it was. Throws if the exchange is still unreachable.
   */
  async reconnect() {
    this.stop();            // clear the poll timer
    this._busy = false;     // break a poll wedged on a hung request
    this.lastError = null;
    if (!this.read || !this.markets.size) return this.init(); // never came up: full init
    const { DecibelReadDex, DecibelWriteDex } = this._sdk;
    this.read = new DecibelReadDex(this._sdkConfig, { nodeApiKey: this.apiKey, onWsError: () => {} });
    this.write = new DecibelWriteDex(this._sdkConfig, this.account, { nodeApiKey: this.apiKey, skipSimulate: true });
    await this._retry(() => this._refreshAccount(), '账户信息', 2); // probe: throws if still down
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  /** Retry transient network failures (ECONNRESET / fetch failed / timeouts). */
  async _retry(fn, label, tries = 4) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        const msg = String(e?.message || '') + ' ' + String(e?.cause?.code || '');
        const transient = /ECONNRESET|ETIMEDOUT|fetch failed|socket|EPIPE|ECONNREFUSED|aborted|UND_ERR/i.test(msg);
        if (!transient || i === tries) throw e;
        console.log(`[Decibel] 读取${label}失败(${e?.cause?.code || e.message})，${i}/${tries - 1} 次重试...`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
    throw lastErr;
  }

  async _loadMarkets() {
    const list = await this.read.markets.getAll();
    let prices = [];
    try { prices = await this._retry(() => this.read.marketPrices.getAll(), '价格快照', 3); } catch { /* lastPrice optional */ }
    const pxByAddr = new Map((prices || []).map((p) => [String(p.market ?? p.market_addr ?? ''), p]));
    const open = (list || []).filter((m) => String(m.mode ?? 'Open') === 'Open');
    let id = 1;
    for (const m of open) {
      const addr = String(m.market_addr);
      const px = pxByAddr.get(addr);
      const lastPrice = px ? (pickNum(px, 'mid_px', 'mark_px', 'oracle_px', 'last_px') ?? 0) : 0;
      const mkt = {
        marketId: id, name: m.market_name, displayName: m.market_name,
        symbol: String(m.market_name).split(/[-/]/)[0],
        addr, lastPrice,
        pxDecimals: Number(m.px_decimals), szDecimals: Number(m.sz_decimals),
        tickSize: Number(m.tick_size), lotSize: Number(m.lot_size), minSize: Number(m.min_size),
        stepPrice: Number(m.tick_size) / 10 ** Number(m.px_decimals),
        stepSize: Number(m.lot_size) / 10 ** Number(m.sz_decimals),
        minOrderSize: Number(m.min_size) / 10 ** Number(m.sz_decimals),
        maxLeverage: Number(m.max_leverage || 20),
      };
      this.markets.set(id, mkt);
      this._byAddr.set(addr, mkt);
      if (lastPrice) this._prices.set(id, lastPrice);
      id++;
    }
    // biggest markets first in the dashboard: sort by notional open interest if present
    // (markets endpoint has no volume; keep listing order from the API)
  }

  // ---------- market data ----------
  async getMarkets() { return [...this.markets.values()]; }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new Error('未知市场 marketId=' + marketId);
    return m;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this._market(marketId);
    const interval = INTERVALS[intervalSec] || '1h';
    const end = Date.now();
    const start = end - Math.min(n, 1000) * intervalSec * 1000;
    const data = await this.read.candlesticks.getByName({ marketName: m.name, interval, startTime: start, endTime: end });
    return (data || [])
      .map((c) => ({ time: Number(c.t ?? c.T), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v ?? 0) }))
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  async getPrice(marketId, opts = {}) {
    const mId = Number(marketId);
    this._watch.add(mId);
    if (opts.touch !== false) this._watchTouch.set(mId, Date.now()); // external interest
    const m = this._market(mId);
    for (let i = 0; i < 2; i++) { // one transparent retry: flaky proxies
      try {
        const p = await this.read.marketPrices.getByName({ marketName: m.name });
        const px = pickNum(p, 'mid_px', 'mark_px', 'oracle_px', 'last_px');
        const ts = pickNum(p, 'transaction_unix_ms');
        if (px > 0) {
          const ageMs = ts == null ? null : Date.now() - ts;
          const directFresh = ageMs != null && ageMs <= 15_000 && ageMs >= -5_000;
          // indexer rows can lag minutes behind the real market; if stale,
          // prefer the close of the latest 1m candle (separate data path)
          if (!directFresh) {  // 索引器行情超过15秒或缺时间戳即视为陈旧，改用最新1m K线
            const fresh = await this._freshPriceFromCandles(m).catch(() => null);
            if (fresh > 0) { this._prices.set(mId, fresh); return fresh; }
            if (opts.requireFresh) continue;
          }
          this._prices.set(mId, px);
          return px;
        }
      } catch { /* retry, then fall back */ }
    }
    if (opts.requireFresh) return null;
    const last = this._prices.get(mId) ?? m.lastPrice;
    return last > 0 ? last : null; // null = no price known; callers must handle
  }

  /** Close of the most recent 1m candle — used when the prices row is stale. */
  async _freshPriceFromCandles(m) {
    const end = Date.now();
    const data = await this.read.candlesticks.getByName({
      marketName: m.name, interval: '1m', startTime: end - 5 * 60 * 1000, endTime: end,
    });
    const latest = (Array.isArray(data) ? data : [])
      .map((c) => {
        const rawTime = pickNum(c, 'T', 't', 'timestamp', 'time');
        const time = rawTime != null && rawTime < 1e12 ? rawTime * 1000 : rawTime;
        return { time, close: Number(c.c ?? c.close) };
      })
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
      .sort((a, b) => b.time - a.time)[0];
    if (!latest || end - latest.time > 90_000 || latest.time - end > 15_000) return null;
    return latest.close;
  }

  // ---------- trading ----------
  async setLeverage(marketId, x) {
    const m = this._market(marketId);
    try {
      await this.write.configureUserSettingsForMarket({
        marketAddr: m.addr, subaccountAddr: this.subaccount,
        isCross: true, userLeverage: Number(x),
      });
      return true;
    } catch (e) { this.emit('error', e); return false; }
  }

  async _submitOrder(m, { side, price, sizeBase, timeInForce, reduceOnly, clientOrderId }) {
    const chainPrice = toChainPrice(price, m);
    const chainSize = toChainSize(sizeBase, m);
    if (chainSize < m.minSize) throw new Error(`数量过小：${sizeBase} 低于市场最小下单量 ${m.minOrderSize}。`);
    const r = await this.write.placeOrder({
      marketName: m.name,
      price: chainPrice, size: chainSize,
      isBuy: side === 'buy',
      timeInForce, isReduceOnly: !!reduceOnly,
      clientOrderId: clientOrderId != null ? String(clientOrderId) : undefined,
      subaccountAddr: this.subaccount,
    });
    if (r && r.success === false) {
      throw new Error('Decibel 拒单: ' + (r.reason || r.error || JSON.stringify(r)));
    }
    const orderId = String(r?.orderId ?? r?.order_id ?? '');
    if (!orderId) throw new Error('下单交易已提交但未返回订单号（可能被链上拒绝）。');
    return { orderId, priceUsed: fromChainPrice(chainPrice, m), sizeUsed: fromChainSize(chainSize, m) };
  }

  async placeLimitOrder(o) {
    const m = this._market(o.marketId);
    // GTC by default: avoids Post Only violations when replenishment orders cross
    // the book due to the 1-3s latency between fill detection and chain submission.
    const tif = (o.postOnly ?? false) ? this.TimeInForce.PostOnly : this.TimeInForce.GoodTillCanceled;
    const { orderId, priceUsed, sizeUsed } = await this._submitOrder(m, {
      side: o.side, price: o.price, sizeBase: o.sizeBase,
      timeInForce: tif, reduceOnly: !!o.reduceOnly, clientOrderId: o.clientOrderId,
    });
    this._watch.add(m.marketId);
    this._tracked.set(orderId, {
      marketId: m.marketId, levelIndex: o.levelIndex, side: o.side,
      price: priceUsed, sizeBase: sizeUsed, reduceOnly: !!o.reduceOnly, seen: false,
      placedAt: Date.now(), goneAttempts: 0, resolving: false,
    });
    return { orderId, priceUsed, sizeUsed };
  }

  async cancelOrder(marketId, orderId) {
    const m = this._market(marketId);
    const result = await this.write.cancelOrder({ orderId: String(orderId), marketName: m.name, subaccountAddr: this.subaccount });
    if (result?.success !== true) return false;
    this._tracked.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const m = this._market(marketId);
    const orderIds = new Set(
      [...this._tracked].filter(([, tracked]) => tracked.marketId === m.marketId).map(([id]) => String(id)),
    );
    const confirmedSubmissions = new Set();
    const ordinaryRows = (rows) => rows.filter((order) =>
      (String(order.market) === m.addr || String(order.market) === m.name) && !order.is_tpsl);
    const submitCancel = async (orderId) => {
      try {
        const result = await this.write.cancelOrder({
          orderId, marketName: m.name, subaccountAddr: this.subaccount,
        });
        if (result?.success === true) confirmedSubmissions.add(orderId);
        return result?.success === true;
      } catch (e) {
        if (this.listenerCount('error')) this.emit('error', e);
        return false;
      }
    };

    // cancelBulkOrder only clears Decibel's bulk-order state. Grid orders are
    // ordinary placeOrder GTC orders, so enumerate and cancel them one by one.
    let rows;
    try { rows = await this._openOrders(); } catch { rows = null; }
    if (!Array.isArray(rows)) return false;
    const initial = ordinaryRows(rows);
    if (initial.some((order) => order.order_id == null || order.order_id === '')) return false;
    for (const order of initial) orderIds.add(String(order.order_id));
    // Aptos transactions share an account sequence number; keep submissions
    // serialized unless the SDK explicitly provides its own batching primitive.
    for (const orderId of orderIds) await submitCancel(orderId);

    // The indexer can transiently return a false-empty snapshot. Require three
    // consecutive empty reads, and cancel any late-appearing ordinary order.
    let emptyStreak = initial.length === 0 ? 1 : 0;
    for (let attempt = 0; attempt < this.cancelConfirmAttempts; attempt++) {
      try { rows = await this._openOrders(); } catch { rows = null; }
      if (!Array.isArray(rows)) {
        emptyStreak = 0;
      } else {
        const remaining = ordinaryRows(rows);
        if (remaining.some((order) => order.order_id == null || order.order_id === '')) return false;
        if (!remaining.length) {
          emptyStreak += 1;
          if (emptyStreak >= 3) {
            for (const [id, tracked] of this._tracked) {
              if (tracked.marketId === m.marketId) this._tracked.delete(id);
            }
            return true;
          }
        } else {
          emptyStreak = 0;
          for (const order of remaining) {
            const orderId = String(order.order_id);
            if (!confirmedSubmissions.has(orderId)) await submitCancel(orderId);
          }
        }
      }
      if (attempt + 1 < this.cancelConfirmAttempts && this.cancelConfirmDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.cancelConfirmDelayMs));
      }
    }
    return false;
  }

  async _openOrders() {
    const limit = 500;
    const all = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const r = await this.read.userOpenOrders.getByAddr({
        subAddr: this.subaccount, limit, offset,
      });
      const rows = Array.isArray(r) ? r : (Array.isArray(r?.items) ? r.items : null);
      if (!rows) return null;
      all.push(...rows);
      const total = !Array.isArray(r) && r?.total_count != null && Number.isFinite(Number(r.total_count))
        ? Number(r.total_count) : null;
      if (total != null && all.length >= total) return all;
      if (!rows.length) return total != null && all.length < total ? null : all;
      if (rows.length < limit && total == null) return all;
      offset += rows.length;
    }
    // The endpoint stayed full through the safety cap (or ignored offset).
    // Returning null prevents callers from mistaking a truncated list for all.
    return null;
  }

  getOpenOrders(marketId) {
    return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId));
  }

  /** REAL resting orders on the exchange for this market (for reconciliation). */
  async fetchOpenOrders(marketId) {
    const m = this._market(marketId);
    const rows = await this._openOrders();
    if (!Array.isArray(rows)) return null;
    const out = [];
    for (const o of rows) {
      if (String(o.market) !== m.addr && String(o.market) !== m.name) continue;
      if (o.is_tpsl) continue;
      // price may come as integer chain units. The old `px > lastPrice*5`
      // heuristic broke whenever lastPrice was 0 (missing at market load) or
      // long-stale — instead pick whichever interpretation (raw vs converted)
      // lands closer to a LIVE reference price.
      let px = pickNum(o, 'price', 'limit_px', 'px', 'order_price');
      if (px != null && m.pxDecimals) {
        const ref = this._prices.get(m.marketId) || m.lastPrice || 0;
        if (ref > 0) {
          const conv = fromChainPrice(px, m);
          if (Math.abs(conv - ref) < Math.abs(px - ref)) px = conv;
        }
      }
      const side = typeof o.is_buy === 'boolean' ? (o.is_buy ? 'buy' : 'sell') : null;
      const sizeBase = o.remaining_size != null && o.remaining_size !== '' ? Number(o.remaining_size) : null;
      const reduceOnly = typeof o.is_reduce_only === 'boolean' ? o.is_reduce_only : null;
      const clientOrderId = o.client_order_id != null ? String(o.client_order_id) : null;
      const metadataComplete = !!o.order_id && Number.isFinite(px) && px > 0
        && ['buy', 'sell'].includes(side) && Number.isFinite(sizeBase) && sizeBase > 0
        && typeof reduceOnly === 'boolean';
      out.push({
        orderId: String(o.order_id),
        ...(clientOrderId != null ? { clientOrderId } : {}),
        price: Number.isFinite(px) ? px : null, side, sizeBase, reduceOnly, metadataComplete,
      });
    }
    return out;
  }

  /** Re-attach a previously-placed order to this adapter's tracking (resume). */
  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, reduceOnly = false }) {
    const mId = Number(marketId);
    this._watch.add(mId);
    this._tracked.set(String(orderId), {
      marketId: mId, levelIndex, side, price: Number(price), sizeBase: Number(sizeBase),
      reduceOnly: !!reduceOnly, seen: false, placedAt: Date.now(), goneAttempts: 0, resolving: false,
    });
  }

  getPosition(marketId) {
    const p = this._pos.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  async refreshPosition(marketId) {
    const m = this._market(marketId);
    const ps = await this.read.userPositions.getByAddr({ subAddr: this.subaccount });
    const rows = Array.isArray(ps) ? ps : (ps?.positions || []);
    const p = rows.find((row) => {
      const market = this._byAddr.get(String(row.market)) || [...this.markets.values()].find((item) => item.name === row.market_name);
      return market?.marketId === m.marketId;
    });
    if (!p || p.is_deleted || !Number(p.size ?? p.open_size ?? 0)) {
      this._pos.delete(m.marketId);
      return null;
    }
    let size = Number(p.size ?? p.open_size ?? 0);
    if (p.is_long === false && size > 0) size = -size;
    if (typeof p.side === 'string' && /short|sell/i.test(p.side) && size > 0) size = -size;
    const entry = Number(p.entry_price ?? 0);
    const mark = this._prices.get(m.marketId) || entry;
    const position = {
      sizeBase: size, entryPrice: entry,
      unrealizedPnl: Number(p.unrealized_pnl ?? (size * (mark - entry))),
      exUpnl: pickNum(p, 'unrealized_pnl'),
      leverage: p.user_leverage != null ? Number(p.user_leverage) : null,
    };
    this._pos.set(m.marketId, position);
    return position;
  }

  /** Close the current position with a reduce-only IOC order at a worst-case price. */
  async closePosition(marketId) {
    const m = this._market(marketId);
    const p = this._pos.get(m.marketId);
    if (!p || !p.sizeBase) return true;
    const isBuy = p.sizeBase < 0; // closing a short buys back
    const last = this._prices.get(m.marketId) || p.entryPrice;
    const worst = last * (isBuy ? 1.05 : 0.95);
    return this._submitOrder(m, {
      side: isBuy ? 'buy' : 'sell', price: worst, sizeBase: Math.abs(p.sizeBase),
      timeInForce: this.TimeInForce.ImmediateOrCancel, reduceOnly: true,
    });
  }

  // ---------- polling ----------
  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._busy) {
      // Watchdog: a poll wedged >90s on a hung request (SDK calls have no
      // timeout) would block polling FOREVER — the exact "数据 Xs 未更新"
      // symptom. Break the lock and poll anyway.
      if (Date.now() - (this._busySince || 0) < 90_000) return;
      console.log('[Decibel] ⚠ 上一轮轮询卡住超过 90 秒，强制解锁继续轮询。');
    }
    this._busy = true; this._busySince = Date.now();
    try {
      // prune idle watch entries: no resting orders, no position, and no external
      // price interest for 10 minutes -> stop polling that market's price
      const nowT = Date.now();
      for (const mId of [...this._watch]) {
        const hasOrders = [...this._tracked.values()].some((t) => t.marketId === mId);
        if (!hasOrders && !this._pos.has(mId) && nowT - (this._watchTouch.get(mId) || 0) > 600_000) {
          this._watch.delete(mId); this._watchTouch.delete(mId); this._pxStale.delete(mId);
        }
      }
      // open orders -> fill detection (account-wide, one call)
      let open = null;
      try { open = await this._openOrders(); } catch { /* keep */ }
      if (open) {
        const liveIds = new Set(open.map((o) => String(o.order_id)));
        for (const id of liveIds) { const t = this._tracked.get(id); if (t) { t.seen = true; t.goneAttempts = 0; } }
        const now = Date.now();
        for (const [id, t] of [...this._tracked]) {
          if (liveIds.has(id) || t.resolving) continue;
          // A tracked order missing from the book is either filled or cancelled.
          // Resolve it once it's either been seen resting OR has aged past the
          // grace window (catches FAST fills that never appear as resting — the
          // old `seen`-only gate silently dropped those and stalled the grid).
          if (!t.seen && now - (t.placedAt || 0) < this._graceMs) continue;
          t.resolving = true;
          this._resolveGone(id, t).finally(() => { t.resolving = false; });
        }
      }
      // latest feed prices for watched markets — store now, emit AFTER reconciling
      // with positions (so a frozen indexer can be detected and overridden).
      const feedPx = new Map();
      await Promise.all([...this._watch].map(async (mId) => {
        try { const px = await this.getPrice(mId, { touch: false }); if (px > 0) feedPx.set(mId, px); } catch { /* keep */ }
      }));
      // positions (account-wide)
      try {
        const ps = await this.read.userPositions.getByAddr({ subAddr: this.subaccount });
        const seen = new Set();
        for (const p of (Array.isArray(ps) ? ps : (ps?.positions || []))) {
          const mkt = this._byAddr.get(String(p.market)) || [...this.markets.values()].find((m) => m.name === p.market_name);
          if (!mkt) continue;
          let size = Number(p.size ?? p.open_size ?? 0);
          if (p.is_long === false && size > 0) size = -size;
          if (typeof p.side === 'string' && /short|sell/i.test(p.side) && size > 0) size = -size;
          if (!size || p.is_deleted) { this._pos.delete(mkt.marketId); continue; }
          const entry = Number(p.entry_price ?? 0);
          const mark = this._prices.get(mkt.marketId) || entry;
          const exUpnl = pickNum(p, 'unrealized_pnl'); // 交易所权威未实现盈亏（缺失为 null）
          this._pos.set(mkt.marketId, {
            sizeBase: size, entryPrice: entry,
            unrealizedPnl: Number(p.unrealized_pnl ?? (size * (mark - entry))),
            exUpnl,
            leverage: p.user_leverage != null ? Number(p.user_leverage) : null,
          });
          seen.add(mkt.marketId);
        }
        for (const mId of this._watch) if (!seen.has(mId)) this._pos.delete(mId);
        // with a single open position the account-level unrealized PnL from
        // the exchange is authoritative — prefer it over our own mark*size math
        if (seen.size === 1 && Number.isFinite(this._acctUpnl)) {
          const only = this._pos.get([...seen][0]);
          if (only) { only.unrealizedPnl = this._acctUpnl; only.exUpnl = this._acctUpnl; }
        }
      } catch { /* keep last */ }
      // emit price for each watched market. SAFETY: Decibel 的行情索引(marketPrices/
      // 蜡烛)可能卡死返回过期缓存价，会让突破区间被隐藏、网格不自动平仓。只要持有仓位，就能
      // 用交易所权威盈亏反推真实标记价(mark = entry + uPnL / size)；若直连价格与之偏离
      // 超过 0.3%，判定行情源滞后，改用持仓推算价，保证出区间风控仍然有效。
      for (const mId of this._watch) {
        let px = feedPx.get(mId) ?? this._prices.get(mId) ?? null;
        const pos = this._pos.get(mId);
        if (pos && pos.sizeBase && pos.entryPrice > 0 && Number.isFinite(pos.exUpnl)) {
          const impliedMark = pos.entryPrice + pos.exUpnl / pos.sizeBase;
          if (Number.isFinite(impliedMark) && impliedMark > 0) {
            // Hysteresis: enter "stale" only on a clear gap (>0.25%), exit only
            // when well back in line (<0.10%). Avoids per-tick flapping/log spam.
            const dev = (px > 0) ? Math.abs(impliedMark - px) / impliedMark : 1;
            const wasStale = this._pxStale.has(mId);
            const nowStale = wasStale ? (dev > 0.0010) : (dev > 0.0025);
            if (nowStale) {
              if (!wasStale) {
                this._pxStale.add(mId);
                console.log(`[Decibel] ⚠ 行情源价格(${px ?? 'N/A'})与持仓推算价(${impliedMark.toFixed(2)})偏离过大，疑似索引滞后，风控改用持仓推算价。`);
              }
              px = impliedMark;
              this._prices.set(mId, impliedMark);
            } else if (wasStale) {
              this._pxStale.delete(mId);
              console.log(`[Decibel] ✓ 行情源已恢复正常(${px})，风控切回直连价格。`);
            }
          }
        }
        if (px > 0) this.emit('price', { marketId: mId, price: px });
      }
      await this._refreshAccount().catch(() => {});
      this.lastOkAt = Date.now();
    } catch (e) { this.lastError = e?.message || String(e); this.emit('error', e); }
    finally { this._busy = false; }
  }

  /**
   * A tracked order disappeared from the book: filled or cancelled?
   * verdict: 'filled' | 'cancelled' | 'unknown'. We only act on a definite
   * verdict; an inconclusive lookup is retried a few times before falling back
   * to "filled", so a transient indexer hiccup can't fabricate a phantom fill
   * (the old code assumed filled on the FIRST failure).
   */
  async _resolveGone(id, t) {
    // POSITIVE-CONFIRMATION fill detection. A vanished order is NOT assumed
    // filled — Decibel's on-chain indexer briefly drops resting orders from the
    // open-order list, which previously fabricated fills and spawned runaway
    // same-side orders. We only emit a fill when the order history shows it
    // actually executed (filledQty > 0 / status FILLED). Anything inconclusive
    // defaults to "not filled": stop tracking, do NOT re-quote.
    let verdict = 'unknown';
    let fillSize = t.sizeBase;
    let fillPrice = t.price;
    let historyExhaustive = true;
    try {
      const limit = 100;
      let o = null;
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        const h = await this.read.userOrderHistory.getByAddr({
          subAddr: this.subaccount, limit, offset,
        });
        const rows = Array.isArray(h) ? h : (Array.isArray(h?.items) ? h.items : null);
        if (!rows) { historyExhaustive = false; break; }
        o = rows.find((row) => String(row.order_id) === String(id)) || null;
        const total = !Array.isArray(h) && h?.total_count != null && Number.isFinite(Number(h.total_count))
          ? Number(h.total_count) : null;
        if (o || (total != null && offset + rows.length >= total)) break;
        if (!rows.length) {
          if (total != null && offset < total) historyExhaustive = false;
          break;
        }
        if (rows.length < limit && total == null) break;
        offset += rows.length;
        if (page === 19) historyExhaustive = false;
      }
      if (o) {
        const st = String(o.status || '');
        const fillQty = Number(o.orig_size ?? 0) - Number(o.remaining_size ?? 0);
        if (/open|new|resting|pending|acknowledged|partial/i.test(st)) {
          // A partial fill is not terminal: keep tracking the remaining order.
          t.goneAttempts = 0;
          t.seen = true;
          return;
        }
        if (fillQty > 0 || /fill|filled|matched|closed/i.test(st)) {
          verdict = 'filled';
          if (fillQty > 0) fillSize = fillQty;
          const historyPrice = pickNum(o, 'average_price', 'avg_price', 'fill_price', 'price');
          if (historyPrice > 0) fillPrice = historyPrice;
        }
        else if (/cancel|reject|expire/i.test(st)) verdict = 'cancelled';
      }
    } catch { historyExhaustive = false; }

    if (verdict === 'unknown') {
      t.goneAttempts = (t.goneAttempts || 0) + 1;
      if (t.goneAttempts < 6 || !historyExhaustive) return; // re-check; a lagging/truncated indexer can hide a resting order
      verdict = 'cancelled';          // never positively confirmed filled -> assume NOT filled
    }
    this._tracked.delete(id);
    if (verdict === 'filled') {
      this.emit('fill', { orderId: id, marketId: t.marketId, side: t.side, price: fillPrice, sizeBase: fillSize, levelIndex: t.levelIndex });
    } else {
      this.emit('error', new Error(`订单 ${id}（${t.side} @ ${t.price}）未确认成交，已停止跟踪（不补单）。`));
    }
  }

  async _refreshAccount() {
    const o = await this.read.accountOverview.getByAddr({ subAddr: this.subaccount });
    if (o) {
      const equity = pickNum(o, 'perp_equity_balance', 'equity', 'account_value');
      const upnl = pickNum(o, 'unrealized_pnl');
      if (equity != null) { this.equity = equity; this.balance = equity - (upnl ?? 0); }
      this._acctUpnl = upnl; // exchange-authoritative unrealized PnL
    }
  }
}
