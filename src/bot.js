// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Risk controls: leverage cap, margin pre-check, fee/spacing check, out-of-range
// alerts (optional auto-stop), periodic open-order reconciliation, crash-safe
// persistence with resume-on-restart, live range adjustment, and a health probe.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';

const RECONCILE_MS = 30000;   // periodic open-order reconciliation cadence
const PRUNE_GRACE_MS = 20000; // don't prune a tracked order younger than this
const TERMINAL_ORDER_LIMIT = 1000; // durable tombstones against stale index snapshots
const PERSISTENCE_TRADING_BLOCK = '状态持久化异常，无法保证重启后接管订单';
const RESUME_SAFETY_BLOCK = '恢复前安全核验失败';

export class GridBot {
  constructor(exchange, opts = {}) {
    this.ex = exchange;
    this.running = false;
    this.config = null;
    this.grid = null;
    this.active = new Map();        // orderId -> {levelIndex, side, price, opening, placedAt}
    this.fills = [];                // recent fills (capped)
    this._terminalOrderIds = new Map(); // filled orderId -> time; independent of resetStats/UI history
    this.alerts = [];               // recent alerts (capped)
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.startBalance = null;
    this.lastPrice = null;
    this.outOfRange = false;
    this.risk = null;
    this._stopping = false;         // re-entrancy guard for auto-stop
    this._coidSeq = 0;              // monotonic client-order-id counter
    this._placeFails = 0;          // cumulative order-placement failures
    this._lastFailAt = 0;
    this._exchangeOpenOrders = null; // last reconciled real open-order count
    this._pendingLevels = new Set(); // levels with a placement in flight (dedup guard)
    this._recoveryOccupied = new Set(); // recovery: real exchange-occupied levels (from reconcile)
    this._reconTimer = null;
    this.recovery = false;          // standalone reduce-only recovery mode
    this.tradingBlock = null;       // unresolved recovery state: no exchange mutations until reconciled
    this.pendingAction = null;       // durable intent for an in-flight exchange mutation
    this.pendingOrders = new Map(); // order-intent id -> request accepted state is not yet known/durable
    this._mutation = null;           // process-local lease serializing public exchange mutations
    this._resumeGate = false;        // listeners may record fills, but no order may be submitted before resume verification
    this._resumePreviousOutOfRange = false;
    this._resumeReviewRequired = false; // durable manual-review latch for a grid that stopped outside its range
    this._resumeDrainActive = false;
    this._resumeDrainPriceCrossed = false;
    this._resumeFinalizeAfterMutation = false;
    this._resumeFinalizePreviousBlock = null;
    this._shuttingDown = false;
    this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null; // persistence hook
    this._onCriticalChange = typeof opts.onCriticalChange === 'function' ? opts.onCriticalChange : null;
    this._canTrade = typeof opts.canTrade === 'function' ? opts.canTrade : null;
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    // CRITICAL: an EventEmitter that emits 'error' with no listener crashes the
    // whole Node process. Adapters emit 'error' on cancelled/rejected orders, so
    // we MUST always have a listener attached for the bot's whole lifetime.
    this._onError = (e) => this._handleExError(e);
    this.ex.on('error', this._onError);
    this._cancelTimes = [];          // timestamps of recent order cancellations
    this._refillPausedUntil = 0;     // back-off window: pause new placements until this time
    this._lastErrAlertAt = 0;
    this._lastErrLogAt = 0;
    this._retryQueue = [];           // failed CLOSING-leg placements awaiting retry (never opening legs)
    this._deferredPlacements = new Map(); // fill replacements waiting for an in-progress mutation
    this._deferredSeq = 0;
    this._drainingDeferred = false;
    this._noPosStreak = 0;           // consecutive empty-position observations (recovery finish guard)
    this._pnlBase = null;            // realizedPnl baseline; resetStats uses an offset because some
                                     // adapters (RISEx) re-fetch realizedPnl from the exchange every poll
  }

  /**
   * Handle an 'error' emitted by the exchange adapter. Never throws (that would
   * crash the process). Records a throttled alert, and — if orders are being
   * cancelled rapidly (the tell-tale of collateral exhaustion or manual
   * intervention) — pauses auto-refill so we stop hammering the exchange and
   * burning gas on orders that just get rejected.
   */
  _handleExError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    const now = Date.now();
    if (now - this._lastErrLogAt > 3000) { this._lastErrLogAt = now; try { console.error('[交易所事件] ' + msg); } catch {} }
    if (now - this._lastErrAlertAt > 5000) { this._lastErrAlertAt = now; this._alert('交易所事件: ' + msg); }

    if (/取消|cancel|collateral|保证金|reject/i.test(msg)) {
      this._cancelTimes.push(now);
      this._cancelTimes = this._cancelTimes.filter((t) => now - t < 60000); // last 60s
      if (this._cancelTimes.length >= 5 && now >= this._refillPausedUntil) {
        this._refillPausedUntil = now + 60000;
        this._alert('⚠️ 检测到 60 秒内多笔订单被取消（疑似保证金不足或手动撤单），已暂停自动补单 60 秒，避免反复被拒、浪费手续费。请检查保证金/减小持仓。');
      }
    }
  }

  /** Notify the persistence layer (if any) that durable state changed. */
  _changed() { try { this._onChange?.(this.snapshot()); } catch { /* never let persistence break trading */ } }

  blockTrading(reason) {
    this.tradingBlock = String(reason || '存在尚未核对的恢复状态');
    this._alert(`⛔ ${this.tradingBlock}`);
  }

  clearTradingBlock() { this.tradingBlock = null; }

  clearRecoveredPersistenceBlock() {
    if (this.tradingBlock !== PERSISTENCE_TRADING_BLOCK) return false;
    if (this.pendingAction || this.pendingOrders.size || (this._canTrade && !this._canTrade())) return false;
    this.clearTradingBlock();
    return true;
  }

  async recoverPersistenceAndReconcile() {
    if (!this.running) return false;
    if (this.tradingBlock !== PERSISTENCE_TRADING_BLOCK) {
      throw new Error('当前不是可自动恢复的持久化临时锁。');
    }
    if (this.pendingAction || this.pendingOrders.size || (this._canTrade && !this._canTrade())) {
      throw new Error('持久化或交易意图尚未恢复，无法解除交易锁。');
    }
    this._resumeGate = true;
    this._resumePreviousOutOfRange = false;
    try {
      return await this._completeResumeSafetyGate();
    } catch (e) {
      this._resumeGate = false;
      this.tradingBlock = PERSISTENCE_TRADING_BLOCK;
      throw e;
    }
  }

  getOperationalBlock() {
    if (this.tradingBlock) return this.tradingBlock;
    // A durable intent owned by this process is an expected part of a live
    // mutation, not a recovery failure. Mark only orphaned/restored intents as
    // unhealthy so the container health check cannot kill a slow chain request.
    if (this.pendingAction && !this._mutation) return `检测到未完成的 ${this.pendingAction.type || '交易所'} 操作，请人工核对挂单和仓位`;
    if (this.pendingOrders.size && !this._pendingLevels.size) return `检测到 ${this.pendingOrders.size} 个结果尚未确认的下单请求，请人工核对交易所`;
    return null;
  }

  assertTradingAllowed() {
    if (this._resumeGate) throw new Error('网格正在执行恢复安全核验，请等待真实行情和挂单对账完成。');
    if (this.tradingBlock) throw new Error(`交易操作已锁定：${this.tradingBlock}。请先重连恢复，或到交易所人工核对挂单/仓位后按文档重置状态。`);
    if (this.pendingAction) throw new Error(`已有 ${this.pendingAction.type || '交易所'} 操作正在执行，请等待完成后再试。`);
    if (this.pendingOrders.size) throw new Error('存在结果尚未确认的下单请求，请先核对交易所挂单后再继续。');
    if (this._canTrade && !this._canTrade()) {
      this.blockTrading(PERSISTENCE_TRADING_BLOCK);
      throw new Error(`交易操作已锁定：${this.tradingBlock}`);
    }
  }

  _backgroundTradingAllowed() {
    if (this._shuttingDown || this._resumeGate || this.tradingBlock) return false;
    if (this._canTrade && !this._canTrade()) {
      this.blockTrading(PERSISTENCE_TRADING_BLOCK);
      return false;
    }
    return true;
  }

  _resumeDrainTradingAllowed() {
    if (this._shuttingDown || this.tradingBlock) return false;
    if (this._canTrade && !this._canTrade()) {
      this.blockTrading(PERSISTENCE_TRADING_BLOCK);
      return false;
    }
    return true;
  }

  _resumeDrainOrderAllowed(order) {
    if (!this._resumeDrainTradingAllowed() || this._resumeDrainPriceCrossed || this.outOfRange) return false;
    const price = Number(this.lastPrice);
    if (!this.recovery && Number.isFinite(price)
        && (price < this.config.lower || price > this.config.upper)) {
      this.outOfRange = true;
      this._resumeDrainPriceCrossed = true;
      return false;
    }
    return !!order;
  }

  async _withMutation(type, work, { allowBlocked = false } = {}) {
    if (this._shuttingDown) throw new Error('程序正在关闭，已拒绝新的交易操作。');
    if (this._mutation) throw new Error(`已有 ${this._mutation.type} 操作正在执行，请等待完成后再试。`);
    if (!allowBlocked) this.assertTradingAllowed();
    const token = Symbol(type);
    this._mutation = { type, token };
    let succeeded = false;
    try {
      const result = await work();
      succeeded = true;
      return result;
    }
    finally {
      if (this._mutation?.token === token) this._mutation = null;
      const finalizeResume = this._resumeFinalizeAfterMutation;
      const finalizePreviousBlock = this._resumeFinalizePreviousBlock;
      if (finalizeResume) {
        this._resumeFinalizeAfterMutation = false;
        this._resumeFinalizePreviousBlock = null;
        if (succeeded) {
          // reconnect/delayed-reconnect may call resume while holding this
          // process-local lease. Keep the resume gate closed until the lease is
          // released, then repeat the fresh-price + strict-book proof and drain
          // inside that gate. A price event observed by the outer operation can
          // therefore never be followed by the generic finally drain below.
          await this._completeResumeSafetyGate({ previousBlock: finalizePreviousBlock });
        } else {
          this._resumeGate = false;
          this.blockTrading(finalizePreviousBlock || `${RESUME_SAFETY_BLOCK}：重连流程未完成，已保留原挂单与补挂意图。`);
          this._changed();
        }
      }
      // A failed mutation may mean the real order book was never verified. Keep
      // durable replacements queued instead of blindly submitting them from a
      // generic finally block.
      if (succeeded && !finalizeResume) {
        try { await this._drainDeferredPlacements(); }
        catch (e) { this._handleExError(e); }
      }
    }
  }

  beginShutdown() {
    this._shuttingDown = true;
    this._stopReconcileTimer();
    this.ex.off('price', this._onPrice);
  }

  _criticalChanged() {
    if (!this._onCriticalChange) throw new Error('未配置关键状态持久化，拒绝在无法保证崩溃恢复时下单。');
    const ok = this._onCriticalChange(this.snapshot());
    if (ok === false) throw new Error('网格关键状态未能可靠落盘，已取消下单；请检查 /app/data 持久卷。');
  }

  _abortUndurableTransition(message) {
    this._stopReconcileTimer();
    this.running = false;
    this.recovery = false;
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.blockTrading(message);
    this._changed(); // replace any failed immediate cache entry with a stopped state
  }

  _beginDurableStop(type = 'stop', details = {}) {
    const wasRunning = this.running;
    const wasRecovery = this.recovery;
    const previousPending = this.pendingAction;
    this.pendingAction = { type, marketName: this.config?.displayName || null, at: Date.now(), ...details };
    this.running = false;
    this.recovery = false;
    try { this._criticalChanged(); }
    catch (e) {
      this.running = wasRunning;
      this.recovery = wasRecovery;
      this.pendingAction = previousPending;
      this._changed();
      throw e;
    }
  }

  _beginDurableAction(type, details = {}) {
    const previous = this.pendingAction;
    this.pendingAction = { type, marketName: this.config?.displayName || null, at: Date.now(), ...details };
    try { this._criticalChanged(); }
    catch (e) { this.pendingAction = previous; this._changed(); throw e; }
  }

  _finishDurableAction() {
    const pending = this.pendingAction;
    this.pendingAction = null;
    try { this._criticalChanged(); }
    catch (e) {
      this.pendingAction = pending;
      this._abortUndurableTransition('交易所操作已执行，但最终状态未能落盘；已锁定后续交易，请立即核对挂单和仓位。');
      throw e;
    }
  }

  /** Durable snapshot for crash recovery / resume. Includes resting orders. */
  snapshot() {
    const exchangeState = this.ex.mode === 'paper' && typeof this.ex.snapshotState === 'function'
      ? this.ex.snapshotState() : null;
    return {
      running: this.running, exchangeMode: this.ex.mode, config: this.config, stats: this.stats,
      recovery: this.recovery, pnlBase: this._pnlBase,
      startBalance: this.startBalance, outOfRange: this.outOfRange, lastPrice: this.lastPrice,
      resumeReviewRequired: this._resumeReviewRequired,
      active: [...this.active.entries()],
      retryQueue: this._retryQueue,
      deferredPlacements: [...this._deferredPlacements.entries()],
      ...(this.pendingAction ? { pendingAction: this.pendingAction } : {}),
      ...(this.pendingOrders.size ? { pendingOrders: [...this.pendingOrders.values()] } : {}),
      terminalOrderIds: [...this._terminalOrderIds.entries()],
      fills: this.fills.slice(0, 50), alerts: this.alerts.slice(0, 30),
      ...(exchangeState ? { exchangeState } : {}),
    };
  }

  _restoreHistory(snap) {
    this.fills = Array.isArray(snap.fills) ? snap.fills.slice(0, 50) : [];
    this.alerts = Array.isArray(snap.alerts) ? snap.alerts.slice(0, 30) : [];
    this._terminalOrderIds = restoreTerminalOrderIds(snap.terminalOrderIds, this.fills);
  }

  _restoreDeferredPlacements(value) {
    this._deferredPlacements = new Map(validateDeferredPlacements(value));
  }

  _restoreExchangeState(snap) {
    if (this.ex.mode !== 'paper' || typeof this.ex.restoreState !== 'function') return;
    try {
      this.ex.restoreState(snap.exchangeState);
    } catch (e) {
      throw unsafeResumeError(`模拟盘账本无法映射到当前市场（${e?.message || e}），已拒绝自动续跑。`);
    }
  }

  _assertResumeCompatible(snap, { allowUnfinished = false } = {}) {
    if (snap.exchangeMode && snap.exchangeMode !== this.ex.mode) {
      throw unsafeResumeError(`快照来自 ${snap.exchangeMode} 模式，当前为 ${this.ex.mode} 模式，已拒绝跨模式自动续跑。请先核对挂单和仓位。`);
    }
    if (!allowUnfinished && snap.pendingAction) throw unsafeResumeError(`检测到未完成的 ${snap.pendingAction.type || '交易所'} 操作，已拒绝猜测式自动续跑。`);
    if (!allowUnfinished && Array.isArray(snap.pendingOrders) && snap.pendingOrders.length) {
      throw unsafeResumeError('检测到结果尚未确认的下单请求，已拒绝猜测式自动续跑。');
    }
    const active = Array.isArray(snap.active) ? snap.active : [];
    const orderIds = new Set();
    const levels = new Set();
    const defaultSize = Number(snap.config?.sizeBase);
    const badActive = !Array.isArray(snap.active) || active.some((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[1] || typeof entry[1] !== 'object') return true;
      const [rawId, order] = entry;
      const id = String(rawId || '');
      const sizeBase = order.sizeBase == null ? defaultSize : Number(order.sizeBase);
      if (!id || orderIds.has(id) || !Number.isInteger(order.levelIndex) || levels.has(order.levelIndex)) return true;
      orderIds.add(id); levels.add(order.levelIndex);
      if (!['buy', 'sell'].includes(order.side) || !Number.isFinite(order.price) || order.price <= 0) return true;
      if (!Number.isFinite(sizeBase) || sizeBase <= 0) return true;
      if (order.recovery === true && (order.reduceOnly !== true || order.opening !== false)) return true;
      if ((snap.recovery || snap.config?.mode === 'recovery') && order.recovery !== true) return true;
      return ['opening', 'reduceOnly', 'recovery'].some((key) => order[key] != null && typeof order[key] !== 'boolean');
    });
    if (badActive) {
      throw unsafeResumeError('网格快照中的挂单记录不完整，已拒绝自动续跑。');
    }
    const hasPaperOrder = active.some(([id]) => /^paper-\d+$/.test(String(id)));
    if (this.ex.mode === 'paper' && !isValidPaperExchangeState(snap.exchangeState)) {
      throw unsafeResumeError('模拟盘快照缺少完整的余额/仓位账本，无法安全自动续跑。运行记录已保留，请核对后手动重新启动模拟网格。');
    }
    if (!snap.exchangeMode && this.ex.mode === 'live') {
      if (hasPaperOrder || active.length === 0) {
        throw unsafeResumeError('旧版快照未记录 paper/live 模式，无法证明可安全接管实盘订单，已拒绝自动续跑。');
      }
    }
    validateRetryQueue(snap.retryQueue);
    validateDeferredPlacements(snap.deferredPlacements);
  }

  async _resolveRestoredMarket({ remapExchange = true } = {}) {
    if (!this.config?.displayName) throw unsafeResumeError('网格快照缺少稳定的市场名称，已拒绝使用可能过期的 marketId。');
    if (typeof this.ex.getMarkets !== 'function') throw unsafeResumeError('当前交易所无法按名称核验恢复市场，已拒绝使用可能过期的 marketId。');
    const want = normalizeMarketName(this.config.displayName);
    if (!want) throw unsafeResumeError('网格快照中的市场名称为空，已拒绝使用可能过期的 marketId。');
    let markets;
    try {
      markets = await this.ex.getMarkets();
    } catch (e) {
      throw unsafeResumeError(`恢复网格时无法取得市场列表（${e?.message || e}），已拒绝使用可能过期的 marketId。`);
    }
    if (!Array.isArray(markets) || !markets.length) throw unsafeResumeError('恢复网格时未取得市场列表，已拒绝使用可能过期的 marketId。');
    const matches = markets.filter((m) =>
      normalizeMarketName(m.displayName) === want ||
      normalizeMarketName(m.name) === want ||
      normalizeMarketName(m.symbol) === want);
    const marketIds = new Set(matches.map((market) => String(market.marketId)));
    if (marketIds.size !== 1 || matches[0]?.marketId == null) {
      const reason = marketIds.size > 1 ? '匹配到多个市场' : '找不到原市场';
      throw unsafeResumeError(`恢复网格时${reason} ${this.config.displayName}，已拒绝使用旧 marketId。`);
    }
    const market = matches[0];
    const previousId = this.config.marketId;
    this.config.marketId = market.marketId;
    if (remapExchange) this.ex.remapMarketId?.(previousId, market.marketId);
  }

  remapMarketId(marketId, { remapExchange = this.ex.mode !== 'paper' } = {}) {
    if (!this.config || marketId == null) return;
    const previousId = this.config.marketId;
    this.config.marketId = marketId;
    if (remapExchange) this.ex.remapMarketId?.(previousId, marketId);
  }

  async refreshMarketMapping() {
    if (!this.config) return false;
    // Paper market-table replacement remaps its complete ledger/orders
    // atomically. Moving one numeric ID again here can corrupt an ID swap.
    await this._resolveRestoredMarket({ remapExchange: this.ex.mode !== 'paper' });
    this._changed();
    return true;
  }

  restoreExchangeState(snap, { allowUnfinished = false } = {}) {
    if (!snap || this.ex.mode !== 'paper') return false;
    if (snap.exchangeMode !== 'paper') return false;
    this._assertResumeCompatible(snap, { allowUnfinished });
    this._restoreExchangeState(snap);
    return true;
  }

  /**
   * Restore display/accounting state after a process restart WITHOUT resuming
   * trading (running stays false). Used when we only want continuity of stats.
   */
  restore(snap) {
    if (!snap || !snap.config) return;
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._restoreHistory(snap);
    this.pendingAction = snap.pendingAction || null;
    this.pendingOrders = new Map((Array.isArray(snap.pendingOrders) ? snap.pendingOrders : []).map((intent) => [String(intent.id), intent]));
    this._restoreDeferredPlacements(snap.deferredPlacements);
    if (this.pendingAction || this.pendingOrders.size) {
      const detail = this.pendingAction
        ? `未完成的 ${this.pendingAction.type || '交易所'} 操作`
        : `${this.pendingOrders.size} 个结果尚未确认的下单请求`;
      this.blockTrading(`检测到${detail}，请核对挂单和仓位`);
    }
    try {
      this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
      this._recomputeRisk();
    } catch { /* config may be incomplete */ }
  }

  /**
   * Resume a grid that was running when the process died: re-attach to the
   * orders still resting on the exchange (rebuilding both our tracking and the
   * adapter's), restart listeners, then reconcile against the real book.
   */
  async resume(snap) {
    if (!snap || !snap.config) throw unsafeResumeError('无可恢复的运行中网格快照');
    if (this.running) throw new Error('已在运行，无法重复恢复');
    if (this._resumeGate) throw new Error('网格正在执行恢复安全核验。');
    this._assertResumeCompatible(snap);
    // Standalone recovery ladder has no grid (gridCount=null): resume it via its
    // own path — the old code fell into buildGrid, threw, and the fallback then
    // CANCELLED the whole ladder while the position stayed open.
    if (snap.recovery || snap.config.mode === 'recovery') return this._resumeRecovery(snap);
    if (!Array.isArray(snap.active)) throw unsafeResumeError('无可恢复的运行中网格快照');
    this.config = { ...snap.config };
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this.outOfRange = !!snap.outOfRange;
    this._resumeReviewRequired = !!snap.resumeReviewRequired || !!snap.outOfRange;
    this.lastPrice = snap.lastPrice ?? null;
    this._restoreHistory(snap);
    this._retryQueue = restoreRetryQueue(snap.retryQueue);
    this._restoreDeferredPlacements(snap.deferredPlacements);
    await this._resolveRestoredMarket();
    this._restoreExchangeState(snap);
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    const resumeEntries = await this._prepareResumeOrders(snap.active);

    // Rebuild our active map AND the adapter's order tracking so fills on these
    // pre-existing orders are detected.
    this.active.clear();
    for (const [id, info] of resumeEntries) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      if (typeof this.ex.adoptOrder === 'function') {
        try {
          this.ex.adoptOrder({
            orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
            side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
            externalId: info.externalId,
            reduceOnly: info.reduceOnly ?? (!!info.recovery || isReduceOnly(info.side, this.config.mode)),
          });
        } catch (e) {
          throw unsafeResumeError(`恢复订单 ${oid} 时交易所适配器拒绝接管（${e?.message || e}）。`);
        }
      }
    }

    this._resumeGate = true;
    this._resumePreviousOutOfRange = this._resumeReviewRequired;
    this.running = true;
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this._alert(`已恢复运行中的 ${this.config.displayName} ${labelMode(this.config.mode)}：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    try {
      await this._completeResumeSafetyGate({ previousBlock: this.tradingBlock });
      return this.getState();
    } catch (e) {
      this._resumeGate = false;
      throw e;
    }
  }

  /** Resume a standalone reduce-only recovery ladder after a process restart. */
  async _resumeRecovery(snap) {
    this.config = { ...snap.config };
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this.grid = null; this.risk = null;
    this.recovery = true; this.outOfRange = false;
    this.lastPrice = snap.lastPrice ?? null;
    this._restoreHistory(snap);
    await this._resolveRestoredMarket();
    this._restoreExchangeState(snap);
    this._noPosStreak = 0; this._retryQueue = restoreRetryQueue(snap.retryQueue);
    this._restoreDeferredPlacements(snap.deferredPlacements);
    const resumeEntries = await this._prepareResumeOrders(Array.isArray(snap.active) ? snap.active : []);
    this.active.clear();
    for (const [id, info] of resumeEntries) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      try {
        this.ex.adoptOrder?.({
          orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
          side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
          externalId: info.externalId,
          reduceOnly: true,
        });
      } catch (e) {
        throw unsafeResumeError(`恢复订单 ${oid} 时交易所适配器拒绝接管（${e?.message || e}）。`);
      }
    }
    this._resumeGate = true;
    this._resumePreviousOutOfRange = false;
    this.running = true;
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this._recoveryOccupied = new Set();
    this._alert(`已恢复 ${this.config.displayName} 的「只减仓回收阶梯」：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    try {
      await this._completeResumeSafetyGate({ previousBlock: this.tradingBlock });
      return this.getState();
    } catch (e) {
      this._resumeGate = false;
      throw e;
    }
  }

  async _completeResumeSafetyGate({ previousBlock = this.tradingBlock } = {}) {
    this._resumeGate = true;
    // Startup may have installed an "exchange offline" block. The resume gate
    // itself forbids every mutation, while allowing the price/order reads needed
    // to prove that takeover is now safe.
    this.tradingBlock = null;
    try {
      await this._verifyResumePrice({ previousOutOfRange: this._resumePreviousOutOfRange });
      await this._reconcileBeforeDeferredResume({ strict: true, allowResumeGate: true });
      // A live price event can arrive while the strict order request is in
      // flight. Re-read a fresh quote after reconciliation so its finally block
      // can never drain intents using a stale/in-range observation.
      await this._verifyResumePrice({ previousOutOfRange: this._resumePreviousOutOfRange });
      if (this._mutation) {
        this._resumeFinalizeAfterMutation = true;
        this._resumeFinalizePreviousBlock = previousBlock;
        return true;
      }
      this._resumeDrainActive = true;
      this._resumeDrainPriceCrossed = false;
      try {
        await this._drainDeferredPlacements({ allowResumeGate: true });
      } finally {
        this._resumeDrainActive = false;
      }
      if (this._resumeDrainPriceCrossed || this.outOfRange) {
        throw unsafeResumeError(`${RESUME_SAFETY_BLOCK}：补挂期间行情已变化并离开网格区间，已保留未提交意图并锁定自动交易。`);
      }
      this._resumePreviousOutOfRange = false;
      this._resumeReviewRequired = false;
      this._resumeGate = false;
      this.clearTradingBlock();
      this._startReconcileTimer();
      this._changed();
      return true;
    } catch (e) {
      this._resumeGate = false;
      if (!this.tradingBlock) this.blockTrading(previousBlock || e?.message || RESUME_SAFETY_BLOCK);
      throw e;
    }
  }

  async _reconcileBeforeDeferredResume({ strict = false, allowResumeGate = false } = {}) {
    const needsStrict = strict || this._deferredPlacements.size > 0;
    try {
      const reconciled = await this.reconcileOpenOrders({
        strict: needsStrict,
        withinMutation: !!this._mutation,
        allowResumeGate,
      });
      if (needsStrict && reconciled !== true) throw new Error('未完成真实挂单对账');
    } catch (e) {
      if (!needsStrict) return;
      const error = unsafeResumeError(`恢复前无法核对真实挂单（${e?.message || e}），已保留补挂意图并拒绝自动下单。`);
      this.blockTrading(error.message);
      this._changed();
      throw error;
    }
  }

  async _verifyResumePrice({ previousOutOfRange = false } = {}) {
    let price;
    try {
      price = await this.ex.getPrice(this.config.marketId, { requireFresh: true });
    } catch (e) {
      const error = unsafeResumeError(`${RESUME_SAFETY_BLOCK}：无法取得实时价格（${e?.message || e}），已拒绝自动续跑。`);
      this.blockTrading(error.message);
      this._changed();
      throw error;
    }
    price = Number(price);
    if (!Number.isFinite(price) || price <= 0) {
      const error = unsafeResumeError(`${RESUME_SAFETY_BLOCK}：无法取得实时价格，已拒绝自动续跑。`);
      this.blockTrading(error.message);
      this._changed();
      throw error;
    }
    this.lastPrice = price;
    const standaloneRecovery = this.recovery || this.config.mode === 'recovery';
    const outside = standaloneRecovery ? false : price < this.config.lower || price > this.config.upper;
    if (outside || (!standaloneRecovery && previousOutOfRange)) {
      this.outOfRange = outside || previousOutOfRange;
      if (!standaloneRecovery) {
        const needsDurableLatch = !this._resumeReviewRequired || !this._resumePreviousOutOfRange;
        this._resumeReviewRequired = true;
        this._resumePreviousOutOfRange = true;
        if (needsDurableLatch) {
          try { this._criticalChanged(); }
          catch (e) {
            const persistenceError = unsafeResumeError(`${RESUME_SAFETY_BLOCK}：区间外人工核对标记无法可靠落盘（${e?.message || e}），已拒绝自动续跑。`);
            this.blockTrading(persistenceError.message);
            throw persistenceError;
          }
        }
      }
      const detail = outside
        ? `当前价 ${price} 已在网格区间外 [${this.config.lower}, ${this.config.upper}]`
        : '停机前网格已处于区间外，当前虽已回区间但回收挂单状态尚未核对';
      const error = unsafeResumeError(`${RESUME_SAFETY_BLOCK}：${detail}，已保留原挂单并拒绝自动补挂，请人工核对后处理。`);
      this.blockTrading(error.message);
      this._changed();
      throw error;
    }
    this.outOfRange = false;
    this._changed();
    return price;
  }

  async _prepareResumeOrders(entries) {
    if (typeof this.ex.prepareResumeOrders !== 'function') return entries;
    try {
      return await this.ex.prepareResumeOrders(entries, this.config.marketId);
    } catch (e) {
      throw unsafeResumeError(`恢复前无法确认旧订单身份（${e?.message || e}），已拒绝自动续跑。`);
    }
  }

  async retryResumeReconciliation() {
    if (!this.running) return false;
    const previousBlock = this.tradingBlock;
    if (!previousBlock || !/(恢复前无法核对真实挂单|恢复前安全核验失败)/.test(previousBlock)) {
      throw new Error('当前不是可通过重连自动重试的恢复对账状态。');
    }
    this._resumeGate = true;
    try {
      return await this._completeResumeSafetyGate({ previousBlock });
    } catch (e) {
      if (!this.tradingBlock) this.blockTrading(previousBlock);
      throw e;
    }
  }

  /**
   * Fallback recovery: cancel any resting orders from a previous run (used when
   * resume is not desired or fails).
   */
  async recoverStrayOrders() {
    return this._withMutation('recover-stray-orders', () => this._recoverStrayOrders());
  }

  async _recoverStrayOrders() {
    if (!this.config) return;
    this._beginDurableStop('recover-stray-orders');
    try { requireExchangeSuccess(await this.ex.cancelAll(this.config.marketId), '撤销遗留挂单'); }
    catch (e) { this._abortUndurableTransition(`恢复失败后的遗留撤单也失败（${e?.message || e}）。`); throw e; }
    this.active.clear();
    this._alert('⚠️ 检测到上次运行未正常结束：已撤销该市场遗留挂单。请确认仓位后重新启动网格。');
    this._finishDurableAction();
  }

  /** @param cfg {marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction} */
  async start(cfg) {
    return this._withMutation('start', async () => {
      if (this.running || this._starting) throw new Error('机器人已在运行或正在启动，请勿重复点击。');
      this._starting = true;
      try { return await this._start(cfg); }
      finally { this._starting = false; }
    });
  }

  async _start(cfg) {
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId, displayName: market.displayName,
      mode: cfg.mode || 'neutral',
      lower: Number(cfg.lower), upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount), sizeBase, leverage,
      // 区间外止损策略：'close'=冲破区间平仓（撤单+平仓+停止）；'recover'=只减仓回收阶梯
      outOfRangeAction: cfg.outOfRangeAction === 'recover' ? 'recover' : 'close',
      stepSize: market.stepSize, stepPrice: market.stepPrice,
    };
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    this._refillPausedUntil = 0; this._cancelTimes = []; // fresh start clears any back-off
    this._retryQueue = []; this._noPosStreak = 0;
    this._deferredPlacements.clear();
    this.recovery = false;

    // record the starting equity up front (margin pre-check, returnPct, recovery)
    if (this.startBalance == null) {
      this.startBalance =
        typeof this.ex.equity === 'number' ? this.ex.equity
        : typeof this.ex.balance === 'number' ? this.ex.balance
        : null;
    }

    // ---- margin pre-check ----
    const requiredMargin = this.risk.requiredMargin;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null) {
      if (requiredMargin > available) {
        throw new Error(`保证金不足：该网格约需 ${round2(requiredMargin)} USDC（名义敞口 ${this.risk.notional}，${leverage}x），当前可用 ${round2(available)} USDC。请降低每格数量/网格数，或提高杠杆/充值后再启动。`);
      }
      if (requiredMargin > available * 0.8) {
        this._alert(`⚠️ 保证金占用偏高：约 ${round2(requiredMargin)} / 可用 ${round2(available)} USDC（>80%），价格波动时有强平风险。`);
      }
    }

    // ---- fee vs spacing sanity check ----
    const feeRate = Number(this.ex.feeRate) || 0.0005;
    const roundTripFeePct = feeRate * 2 * 100;
    if (this.risk.spacingPct <= roundTripFeePct) {
      this._alert(`⚠️ 网格间距 ${this.risk.spacingPct}% 不足以覆盖往返手续费（约 ${round2(roundTripFeePct)}%），每完成一格可能亏损。建议拉大间距或减少网格数。`);
    }

    this.lastPrice = await this.ex.getPrice(market.marketId);
    if (!Number.isFinite(this.lastPrice) || this.lastPrice <= 0) {
      throw new Error('未能获取有效的最新价（行情中断），已取消启动以免错挂网格单。请稍后重试。');
    }
    if (this.lastPrice < this.config.lower || this.lastPrice > this.config.upper) {
      throw new Error(`网格区间 [${this.config.lower}, ${this.config.upper}] 必须包含最新价 ${this.lastPrice}，已取消启动。请刷新行情后重设区间。`);
    }
    this.outOfRange = false;

    // A previous stop/cancel may deliberately leave the position open. Starting
    // a new ladder cancels its old exits, so verify the retained inventory
    // before that side effect and ensure the selected grid can cover it.
    let position;
    if (typeof this.ex.refreshPosition === 'function') position = await this.ex.refreshPosition(market.marketId);
    else position = this.ex.getPosition?.(market.marketId) ?? null;
    buildPositionExitOrders({
      position, levels: this.grid.levels, price: this.lastPrice,
      mode: this.config.mode, defaultSize: this.config.sizeBase,
    });

    this.active.clear();
    this._beginDurableAction('start');
    const levOk = await this.ex.setLeverage(market.marketId, leverage).catch(() => false);
    if (levOk === false) this._alert(`⚠️ 杠杆设置 ${leverage}x 未生效，将沿用交易所端该市场的当前杠杆，请在交易所网页端核实后再继续。`);
    try { requireExchangeSuccess(await this.ex.cancelAll(market.marketId), '启动前撤单'); }
    catch (e) {
      this._abortUndurableTransition(`启动前撤单失败（${e?.message || e}），已锁定后续交易。`);
      throw e;
    }

    // Orders can fill while cancelAll is in flight. Refresh after the exchange
    // confirms cancellation, then persist the exact exit plan before submitting
    // any new order. Exit protection wins level conflicts with opening seeds.
    if (typeof this.ex.refreshPosition === 'function') position = await this.ex.refreshPosition(market.marketId);
    else position = this.ex.getPosition?.(market.marketId) ?? position;
    const exitOrders = buildPositionExitOrders({
      position, levels: this.grid.levels, price: this.lastPrice,
      mode: this.config.mode, defaultSize: this.config.sizeBase,
    });

    this.running = true;
    try { this._criticalChanged(); }
    catch (e) {
      this._abortUndurableTransition('关键状态未能落盘，启动已中止且未提交网格挂单。');
      throw e;
    }
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();

    // ---- protect retained inventory, then seed OPENING legs ----
    for (const exit of exitOrders) await this._place(exit);
    const seeds = seedOrders({ levels: this.grid.levels, price: this.lastPrice, mode: this.config.mode, spacing: this.grid.spacing });
    for (const s of seeds) await this._place({ ...s, opening: true });

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    this.running = true;
    this._startReconcileTimer();
    this._alert(`已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x，挂出 ${this.active.size} 单。`);
    this._finishDurableAction();
    return this.getState();
  }

  async stop({ closePosition = true } = {}) {
    return this._withMutation('stop', () => this._stop({ closePosition }));
  }

  async _stop({ closePosition = true } = {}) {
    this._stopReconcileTimer();
    if (!this.running) {
      if (this.config) {
        this._beginDurableStop('stop', { closePosition: !!closePosition });
        try { requireExchangeSuccess(await this.ex.cancelAll(this.config.marketId), '停止网格撤单'); }
        catch (e) { this._abortUndurableTransition(`停止时撤单失败（${e?.message || e}）。`); throw e; }
        if (closePosition && typeof this.ex.closePosition === 'function') {
          const closed = await this._closeWithConfirm(this.config.marketId);
          if (!closed) { this._abortUndurableTransition('未能确认仓位已平，停止操作仍待人工处理。'); throw new Error('未能确认仓位已平'); }
        }
        this._alert('已尝试撤销该市场的所有挂单并平仓。');
      }
      this.active.clear();
      this._retryQueue = [];
      this._deferredPlacements.clear();
      this._finishDurableAction();
      return this.getState();
    }
    this._beginDurableStop('stop', { closePosition: !!closePosition });
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    try { requireExchangeSuccess(await this.ex.cancelAll(this.config.marketId), '停止网格撤单'); }
    catch (e) { this._abortUndurableTransition(`停止时撤单失败（${e?.message || e}）。`); throw e; }
    this.active.clear();
    let closeRequested = false;
    if (closePosition && typeof this.ex.closePosition === 'function') {
      const closed = await this._closeWithConfirm(this.config.marketId);
      if (!closed) { this._abortUndurableTransition('未能确认仓位已平，停止操作仍待人工处理。'); throw new Error('未能确认仓位已平'); }
      closeRequested = true;
    }
    this._retryQueue = [];
    this._deferredPlacements.clear();
    this._alert(closeRequested
      ? '机器人已停止：挂单已撤销，已发送平仓指令（请在交易所确认仓位已平）。'
      : '机器人已停止，挂单已撤销（未平仓）。');
    this._finishDurableAction();
    return this.getState();
  }

  /**
   * One-click: cancel ALL resting orders for this market WITHOUT touching the
   * open POSITION. Also stops the grid (running=false) and detaches handlers so
   * no later automated action (fill replacements / auto-stop) can affect the
   * position afterwards. To resume trading, start the grid again.
   */
  async cancelAllOrders() {
    return this._withMutation('cancel-orders', () => this._cancelAllOrders());
  }

  async _cancelAllOrders() {
    if (!this.config) throw new Error('尚未配置市场，没有可撤的挂单。');
    this._stopReconcileTimer();
    this._beginDurableStop('cancel-orders');
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    try { requireExchangeSuccess(await this.ex.cancelAll(this.config.marketId), '撤销全部挂单'); }
    catch (e) { this._abortUndurableTransition(`撤单失败（${e?.message || e}）。`); throw e; }
    this.active.clear();
    this._refillPausedUntil = 0; this._cancelTimes = []; this._retryQueue = [];
    this._deferredPlacements.clear();
    this._alert('已一键撤销该市场全部挂单（持仓保留、未平仓）。网格已停止，如需继续请重新启动。');
    this._finishDurableAction();
    return this.getState();
  }

  /**
   * Adjust the grid's price range WITHOUT stopping. Margin is re-checked against
   * the new range; if it passes, current orders are cancelled and the ladder is
   * re-seeded around the live price. The open POSITION is left untouched.
   */
  async adjustRange({ lower, upper }) {
    return this._withMutation('adjust-range', () => this._adjustRange({ lower, upper }));
  }

  async _adjustRange({ lower, upper }) {
    if (!this.running || !this.config) throw new Error('网格未在运行，无法调整区间。');
    const lo = Number(lower), hi = Number(upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) throw new Error('上边界必须大于下边界。');
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('当前行情无效，无法安全调整网格区间。');
    }
    if (price < lo || price > hi) {
      throw new Error(`新区间 [${lo}, ${hi}] 必须包含当前价 ${round2(price)}，已取消调整。`);
    }
    const newGrid = buildGrid({ lower: lo, upper: hi, gridCount: this.config.gridCount });
    const mid = (lo + hi) / 2;
    const notional = newGrid.count * this.config.sizeBase * mid;
    const requiredMargin = notional / this.config.leverage;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null && requiredMargin > available) {
      throw new Error(`保证金不足以支持新区间：约需 ${round2(requiredMargin)} USDC，当前可用 ${round2(available)} USDC。请缩小区间/减少格数后再试。`);
    }

    // Cancelling the old ladder also removes its reduce-only exits. Resolve an
    // authoritative position before that side effect and prepare complete exit
    // coverage on the new grid; otherwise a retained long/short position would
    // be left naked after range adjustment.
    let position;
    if (typeof this.ex.refreshPosition === 'function') position = await this.ex.refreshPosition(this.config.marketId);
    else position = this.ex.getPosition?.(this.config.marketId) ?? null;
    buildPositionExitOrders({
      position, levels: newGrid.levels, price, mode: this.config.mode,
      defaultSize: this.config.sizeBase,
    });

    const oldConfig = this.config, oldGrid = this.grid, oldOutOfRange = this.outOfRange;
    const previousActive = this.active;
    const previousDeferred = this._deferredPlacements;
    this._beginDurableAction('adjust-range', { lower: lo, upper: hi });
    this._refillPausedUntil = 0; this._cancelTimes = []; // user re-set the range: clear back-off
    this._deferredPlacements = new Map();
    try { this._criticalChanged(); }
    catch (e) {
      this.config = oldConfig; this.grid = oldGrid; this.outOfRange = oldOutOfRange;
      this.active = previousActive;
      this._deferredPlacements = previousDeferred;
      this.pendingAction = null;
      this._changed();
      throw e;
    }
    try { requireExchangeSuccess(await this.ex.cancelAll(oldConfig.marketId), '调整区间撤单'); }
    catch (e) {
      this._abortUndurableTransition(`调整区间时撤单失败（${e?.message || e}），已锁定后续交易。`);
      throw e;
    }
    // Fills can arrive while cancellation is in flight. Their protective
    // replacements were computed from the old grid and are now represented by
    // the authoritative post-cancel position. Rebuild complete exits below;
    // keeping the old level indexes would collide with neutral-mode new seeds.
    this._deferredPlacements.clear();
    if (typeof this.ex.refreshPosition === 'function') position = await this.ex.refreshPosition(oldConfig.marketId);
    else position = this.ex.getPosition?.(oldConfig.marketId) ?? position;
    const finalExitOrders = buildPositionExitOrders({
      position, levels: newGrid.levels, price, mode: oldConfig.mode,
      defaultSize: oldConfig.sizeBase,
    });
    this.config = { ...oldConfig, lower: lo, upper: hi };
    this.grid = newGrid;
    this._recomputeRisk();
    this.outOfRange = Number.isFinite(price) ? (price < lo || price > hi) : false;
    this.active = new Map();
    try { this._criticalChanged(); }
    catch (e) {
      this._abortUndurableTransition(`旧区间挂单已撤销，但新区间状态未能落盘（${e?.message || e}）。`);
      throw e;
    }
    // Exit orders win level conflicts. Opening seeds at an occupied exit level
    // are deliberately skipped by _place's one-order-per-level invariant.
    for (const exit of finalExitOrders) await this._place(exit);
    const seeds = seedOrders({ levels: newGrid.levels, price, mode: this.config.mode, spacing: newGrid.spacing });
    for (const s of seeds) await this._place({ ...s, opening: true });
    this._alert(`已调整区间为 [${lo}, ${hi}]，${newGrid.count} 格，间距 ${newGrid.spacing}（${this.risk.spacingPct}%），重新挂出 ${this.active.size} 单（持仓保留）。`);
    this._finishDurableAction();
    return this.getState();
  }

  /** Zero cumulative stats and re-baseline PnL to the current equity. */
  resetStats() {
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.fills = [];
    this._placeFails = 0;
    this._lastFailAt = 0;
    this._refillPausedUntil = 0; this._cancelTimes = [];
    this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : this.startBalance;
    // Offset-based reset: adapters like RISEx refresh realizedPnl from the
    // exchange every poll, so writing 0 into it never sticks — record a
    // baseline instead and subtract it in getState.
    this._pnlBase = typeof this.ex.realizedPnl === 'number' ? this.ex.realizedPnl : null;
    this._alert('已重置统计：已实现盈亏、收益率、成交量、完成格数清零，并以当前权益为新基准。');
    this._changed();
    return this.getState();
  }

  _recomputeRisk() {
    if (!this.grid || !this.config) return;
    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.count * this.config.sizeBase * mid;
    this.risk = {
      leverage: this.config.leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / this.config.leverage),
      perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };
  }

  async _place(o, { deferredId = null, allowResumeGate = false } = {}) {
    const tradingAllowed = allowResumeGate
      ? this._resumeDrainOrderAllowed(o)
      : this._backgroundTradingAllowed();
    if (!tradingAllowed) throw new Error(`交易操作已锁定：${this.tradingBlock}`);
    const opening = o.opening !== false;
    const reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
    // Back-off: while paused (after a burst of cancellations / collateral
    // rejections) do not place new OPENING orders. CLOSING / reduce-only /
    // recovery legs need no extra margin and are never blocked — dropping a
    // take-profit leg would strand its inventory without an exit order.
    if (opening && !o.recovery && this._refillPausedUntil && Date.now() < this._refillPausedUntil) return;
    // INVARIANT: at most ONE resting order per grid level. If this level is
    // already covered (or a placement for it is in flight), skip. Stacking a
    // second order on an occupied level is exactly what made the open-order
    // count creep up over time (replacement-one-rung-away colliding with the
    // order already resting there).
    const lvl = o.levelIndex;
    if (this._pendingLevels.has(lvl)) return;
    for (const a of this.active.values()) if (a.levelIndex === lvl) return;
    this._pendingLevels.add(lvl);
    const seq = (++this._coidSeq) % 1_000_000;
    const clientOrderId = Number(`${Date.now() % 1_000_000_0}${String(seq).padStart(6, '0')}`);
    const sizeBase = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase; // per-order override (partial fills)
    const intentId = String(clientOrderId);
    const intent = {
      id: intentId, clientOrderId, marketName: this.config.displayName,
      levelIndex: lvl, side: o.side, price: o.price, sizeBase,
      opening, reduceOnly, recovery: !!o.recovery, at: Date.now(),
    };
    try {
      const deferred = deferredId ? this._deferredPlacements.get(String(deferredId)) : null;
      if (deferredId) this._deferredPlacements.delete(String(deferredId));
      this.pendingOrders.set(intentId, intent);
      try { this._criticalChanged(); }
      catch (e) {
        this.pendingOrders.delete(intentId);
        if (deferred) this._deferredPlacements.set(String(deferredId), deferred);
        this._changed();
        throw e;
      }
      let r;
      try {
        r = await this.ex.placeLimitOrder({
          marketId: this.config.marketId, side: o.side, price: o.price,
          sizeBase, reduceOnly,
          levelIndex: o.levelIndex, clientOrderId,
        });
      } catch (e) {
        this._placeFails++; this._lastFailAt = Date.now();
        this._alert('下单结果无法确认: ' + (e?.message || e));
        this._abortUndurableTransition(`下单请求结果无法确认（clientOrderId=${clientOrderId}），请到交易所核对后再继续。`);
        throw e;
      }
      if (!r?.orderId) {
        const error = new Error(`交易所未返回 orderId（clientOrderId=${clientOrderId}），订单结果无法确认`);
        this._abortUndurableTransition(error.message);
        throw error;
      }
      const acceptedPrice = Number.isFinite(Number(r.priceUsed)) ? Number(r.priceUsed) : Number(o.price);
      const acceptedSize = Number.isFinite(Number(r.sizeUsed)) && Number(r.sizeUsed) > 0 ? Number(r.sizeUsed) : sizeBase;
      this.active.set(String(r.orderId), {
        levelIndex: lvl, side: o.side, price: acceptedPrice, sizeBase: acceptedSize, opening, reduceOnly,
        recovery: !!o.recovery, placedAt: Date.now(),
        ...(r.externalId != null ? { externalId: String(r.externalId) } : {}),
      });
      this.pendingOrders.delete(intentId);
      try { this._criticalChanged(); }
      catch (e) {
        this.pendingOrders.set(intentId, intent);
        this._abortUndurableTransition(`订单已提交但最终状态未能落盘（clientOrderId=${clientOrderId}），请到交易所核对。`);
        throw e;
      }
      return r;
    } finally {
      this._pendingLevels.delete(lvl);
    }
  }

  _queueDeferredPlacement(order) {
    const id = `replacement-${Date.now()}-${++this._deferredSeq}`;
    this._deferredPlacements.set(id, { ...order });
    return id;
  }

  async _drainDeferredPlacements({ allowResumeGate = false } = {}) {
    const tradingAllowed = () => allowResumeGate
      ? this._resumeDrainTradingAllowed()
      : this._backgroundTradingAllowed();
    if (this._drainingDeferred || !this.running || (this._resumeGate && !allowResumeGate) || this._mutation || this.pendingAction
        || this.pendingOrders.size || this.outOfRange || !this._deferredPlacements.size
        || !tradingAllowed()) return;
    this._drainingDeferred = true;
    try {
      let progressed = true;
      while (progressed && this._deferredPlacements.size) {
        progressed = false;
        for (const [id, order] of [...this._deferredPlacements]) {
          if (!this.running || (this._resumeGate && !allowResumeGate) || this._mutation || this.pendingAction || this.pendingOrders.size
              || this.outOfRange || !tradingAllowed()) return;
          // A temporarily occupied level must not block independent replacements
          // behind it. Keep this intent for a later drain and continue with others.
          if (this._pendingLevels.has(order.levelIndex)
              || [...this.active.values()].some((active) => active.levelIndex === order.levelIndex)) continue;
          await this._place(order, { deferredId: id, allowResumeGate });
          if (!this._deferredPlacements.has(id)) progressed = true;
        }
      }
    } finally {
      this._drainingDeferred = false;
    }
  }

  /**
   * Queue a CLOSING / reduce-only order for retry after a failed placement.
   * Only closing legs are retried — they can never ADD inventory, so retrying is
   * always safe; silently dropping one (the old behavior) left inventory without
   * its take-profit order forever, since replacements are only quoted on fills.
   */
  _queueRetry(o) {
    if (o.opening !== false && !o.reduceOnly && !o.recovery) return; // opening legs: by design not retried
    const tries = (o._tries || 0) + 1;
    if (tries > 5) {
      this._alert(`❌ 补挂平仓单（level ${o.levelIndex} @ ${o.price}）连续 ${tries - 1} 次失败，已放弃。请到交易所核实并手动挂单。`);
      return;
    }
    this._retryQueue.push({ ...o, _tries: tries, _nextAt: Date.now() + 5000 * tries }); // linear back-off
  }

  /** Retry due closing-leg placements (driven by price ticks + reconcile timer). */
  _drainRetryQueue() {
    if (!this.running || this.tradingBlock || this.pendingAction || this._mutation || !this._retryQueue.length) return;
    const now = Date.now();
    const due = [];
    this._retryQueue = this._retryQueue.filter((o) => (o._nextAt <= now ? (due.push(o), false) : true));
    if (due.length) this._changed();
    for (const o of due) this._place(o).catch((e) => this._handleExError(e));
  }

  _handleFill(f) {
    if (!this.running || f.marketId !== this.config.marketId) return;
    const id = String(f.orderId);
    if (this._terminalOrderIds.has(id)) return; // duplicate adapter/history event
    const act = this.active.get(id);
    this.active.delete(id);
    const levelIndex = act?.levelIndex ?? f.levelIndex;
    const fillPrice = Number.isFinite(f.price) ? f.price : (act?.price ?? 0);
    const fillSize = Number.isFinite(f.sizeBase) ? f.sizeBase : this.config.sizeBase;

    if (f.side === 'buy') this.stats.buys++; else this.stats.sells++;
    this.stats.volume = round2(this.stats.volume + fillPrice * fillSize);
    this.fills.unshift({ t: Date.now(), orderId: id, side: f.side, price: fillPrice, size: fillSize, level: levelIndex });
    if (this.fills.length > 50) this.fills.pop();
    this._terminalOrderIds.set(id, Date.now());
    while (this._terminalOrderIds.size > TERMINAL_ORDER_LIMIT) {
      this._terminalOrderIds.delete(this._terminalOrderIds.keys().next().value);
    }

    const isRecovery = !!(act && act.recovery);
    const closing = isRecovery ? true
      : (act ? act.opening === false
             : ((this.config.mode === 'short') ? f.side === 'buy' : f.side === 'sell'));
    if (closing) {
      this.stats.completedRungs++;
      // Incremental accumulation with the ACTUAL fill size: adjustRange no longer
      // rewrites history (the old code recomputed rungs × CURRENT spacing), and
      // partial fills are credited with what really executed.
      const sp = this.grid?.spacing ?? this.config.spacing ?? 0;
      this.stats.gridProfit = round2(this.stats.gridProfit + sp * fillSize);
    }

    // Recovery-ladder fills are pure reduce-only EXITS of stranded inventory —
    // never re-quote a replacement for them. A normal fill's replacement is
    // queued durably before any in-progress mutation can defer it.
    let deferredId = null;
    if (!isRecovery && this.grid) {
      const repl = replacementFor({ side: f.side, levelIndex }, this.grid.levels, this.config.mode);
      if (repl && !this.outOfRange && this.running) {
        repl.opening = closing;
        if (fillSize > 0) repl.sizeBase = fillSize;
        deferredId = this._queueDeferredPlacement(repl);
      }
    }

    // A fill changes inventory, the live order set, and possibly the deferred
    // replacement. Persist all three synchronously before submitting anything.
    try { this._criticalChanged(); }
    catch {
      this._abortUndurableTransition('成交状态未能可靠落盘，已停止自动补单并锁定交易。');
      return;
    }

    if (deferredId) this._drainDeferredPlacements().catch((e) => this._handleExError(e));
    this._changed();
  }

  _handlePrice(p) {
    if (p.marketId !== this.config.marketId) return;
    this.lastPrice = p.price;
    const wasOutOfRange = this.outOfRange;
    const out = !this.recovery && Number.isFinite(p.price)
      ? p.price < this.config.lower || p.price > this.config.upper
      : false;
    if (!this.recovery && this._resumeDrainActive && out) {
      this.outOfRange = true;
      this._resumeDrainPriceCrossed = true;
    }
    // During the resume gate we must remember a price crossing even though all
    // exchange mutations remain disabled. During an ordinary mutation/pending
    // order, keep the old edge state so the next tick can still trigger action.
    if (!this.recovery && this._resumeGate) {
      if (out) {
        const needsDurableLatch = !this._resumeReviewRequired || !this._resumePreviousOutOfRange;
        this.outOfRange = true;
        this._resumeReviewRequired = true;
        this._resumePreviousOutOfRange = true;
        if (needsDurableLatch) {
          try { this._criticalChanged(); }
          catch (e) {
            this.blockTrading(`${PERSISTENCE_TRADING_BLOCK}（恢复期间的区间外人工核对标记未能落盘：${e?.message || e}）`);
          }
        }
      } else if (!this._resumeReviewRequired) {
        this.outOfRange = false;
      }
    }
    if (!this._backgroundTradingAllowed() || this.pendingAction || this.pendingOrders.size || this._mutation) return;
    if (!this.recovery) this.outOfRange = out;
    this._drainRetryQueue();
    if (this.recovery) { this._manageRecoveryStandalone().catch(() => {}); return; }
    const action = this.config.outOfRangeAction || 'close';
    if (out && !wasOutOfRange) {
      const where = p.price < this.config.lower ? '跌破下边界' : '突破上边界';
      if (action === 'recover') {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），启用「只减仓回收阶梯」：暂停补单，挂出 reduce-only 单等回调分批减仓（只减不加、不自动止损，请自行控制风险）。`);
        this._placeRecoveryLadder().catch((e) => this._handleExError(e));
      } else {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），触发「冲破区间平仓」：撤单 + 平仓 + 停止。`);
        if (!this._stopping) {
          this._stopping = true;
          this.stop({ closePosition: true })
            .catch((e) => this._handleExError(e))
            .finally(() => { this._stopping = false; });
        }
      }
    } else if (out && action === 'recover') {
      this._placeRecoveryLadder().catch((e) => this._handleExError(e)); // extend the ladder as price makes new extremes
    } else if (!out && (wasOutOfRange || [...this.active.values()].some((order) => order.recovery))) {
      this._cancelRecoveryLadder().catch((e) => this._handleExError(e));
    }
  }

  /**
   * 只减仓回收阶梯：价格冲出区间后，在「现价 ↔ 被冲破的边界」之间挂一批 reduce-only
   * 单。价格每回调一档就分批了结被套住的库存。reduce-only 保证「只减不加」（永远不会
   * 把套牢的仓位越加越大）；本策略不自动止损 —— 趋势继续单边延续会一直扛着。
   */
  async _placeRecoveryLadder() {
    if (this._mutation) return;
    return this._withMutation('place-recovery-ladder', () => this._placeRecoveryLadderImpl());
  }

  async _placeRecoveryLadderImpl() {
    if (!this.running || !this.outOfRange || !this.grid || !this._backgroundTradingAllowed()) return;
    if ((this.config.outOfRangeAction || 'close') !== 'recover') return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) return; // 没有可减的持仓
    const sp = this.grid.spacing, lvl0 = this.grid.levels[0];
    const L = this.config.lower, U = this.config.upper;
    const long = pos.sizeBase > 0;
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    const maxRungs = this.grid.count;
    let placed = 0;
    const room = () => existing.size + placed < maxRungs;
    if (long && price < L) {
      // 跌破下边界、手里是多头：在「现价 ↔ 下边界」之间挂 reduce-only 卖单
      for (let lv = L - sp; lv > price && room(); lv -= sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        await this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else if (!long && price > U) {
      // 突破上边界、手里是空头：在「上边界 ↔ 现价」之间挂 reduce-only 买单
      for (let lv = U + sp; lv < price && room(); lv += sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        await this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) {
      this._alert(`回收阶梯：新挂 ${placed} 个 reduce-only ${long ? '卖' : '买'}单，等回调分批减仓。`);
      this._changed();
    }
  }

  /** Cancel all recovery-ladder orders (when price returns into range). */
  async _cancelRecoveryLadder() {
    return this._withMutation('cancel-recovery-ladder', () => this._cancelRecoveryLadderImpl());
  }

  async _cancelRecoveryLadderImpl() {
    const ids = [...this.active].filter(([, o]) => o.recovery).map(([id]) => id);
    if (!ids.length) return;
    this._beginDurableAction('cancel-recovery-ladder');
    try {
      if (typeof this.ex.cancelOrder !== 'function') throw new Error('当前交易所不支持逐单撤销回收阶梯');
      for (const id of ids) {
        requireExchangeSuccess(await this.ex.cancelOrder(this.config.marketId, id), '撤销回收阶梯挂单');
        this.active.delete(id);
      }
    } catch (e) {
      this._abortUndurableTransition(`回收阶梯撤单失败（${e?.message || e}），已锁定后续交易。`);
      throw e;
    }
    this._alert(`已撤销 ${ids.length} 个回收阶梯挂单。`);
    this._finishDurableAction();
  }

  // ============ 未托管持仓处置（开机扫描后手动选择）============

  /**
   * 只减仓回收阶梯（独立模式）：对一笔已存在的持仓，挂 reduce-only 单在反弹时分批
   * 减仓；只减不加、不需要新保证金、不自动止损。不需要完整网格。
   */
  async startRecovery(cfg) {
    return this._withMutation('start-recovery', () => this._startRecovery(cfg));
  }

  async _startRecovery(cfg) {
    if (this.running || this._starting) throw new Error('已在运行，请先停止再操作。');
    this._starting = true;
    try {
      const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
      if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);
      let pos;
      try {
        pos = typeof this.ex.refreshPosition === 'function'
          ? await this.ex.refreshPosition(market.marketId)
          : this.ex.getPosition?.(market.marketId);
      } catch (e) {
        throw new Error(`未能在撤单前确认真实持仓（${e?.message || e}）。`);
      }
      if (!pos || !pos.sizeBase) throw new Error('该市场当前没有持仓，无需回收。');
      const price = await this.ex.getPrice(market.marketId);
      if (!Number.isFinite(price) || price <= 0) throw new Error('未能获取有效最新价，请稍后重试。');
      // 阶梯间距：入参 -> 上次网格间距 -> 现价的 0.15%
      let spacing = Number(cfg.spacing) || this.config?.spacing || this.grid?.spacing;
      if (!(spacing > 0)) spacing = Math.max(market.stepPrice || 0.1, price * 0.0015);
      // 每档减仓量：入参 -> 上次每格量 -> 持仓量/20
      let sizeBase = Number(cfg.sizeBase) || this.config?.sizeBase || (Math.abs(pos.sizeBase) / 20);
      sizeBase = Math.max(sizeBase, market.minOrderSize || 0);
      this.config = {
        marketId: market.marketId, displayName: market.displayName, mode: 'recovery',
        sizeBase, spacing, stepSize: market.stepSize, stepPrice: market.stepPrice,
        lower: null, upper: null, gridCount: null, leverage: pos.leverage ?? null,
        outOfRangeAction: 'recover',
        aboveEntryOnly: !!cfg.aboveEntryOnly, // 只在成本价上方(多)/下方(空)、即不亏的价位才挂减仓单
      };
      this.grid = null; this.risk = null;
      this.recovery = true; this.outOfRange = false; this.lastPrice = price;
      this._noPosStreak = 0; this._retryQueue = [];
      this._deferredPlacements.clear();
      this.active.clear();
      if (this.startBalance == null) {
        this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
          : typeof this.ex.balance === 'number' ? this.ex.balance : null;
      }
      this._beginDurableAction('start-recovery');
      try { requireExchangeSuccess(await this.ex.cancelAll(market.marketId), '启动回收策略前撤单'); }
      catch (e) {
        this._abortUndurableTransition(`启动回收策略前撤单失败（${e?.message || e}），已锁定后续交易。`);
        throw e;
      }
      // Open-order APIs do not expose a trustworthy reduce-only flag on all
      // three live venues. Never relabel an unknown resting order as a recovery
      // exit: cancel the market first, then rebuild only orders we submit with
      // reduceOnly=true. Re-read the position after cancellation to include any
      // fill that raced the cancel request.
      let finalPosition = pos;
      try {
        if (typeof this.ex.refreshPosition === 'function') finalPosition = await this.ex.refreshPosition(market.marketId);
        else finalPosition = this.ex.getPosition?.(market.marketId) ?? pos;
      } catch (e) {
        this._abortUndurableTransition(`启动回收策略前无法确认最终持仓（${e?.message || e}），已锁定后续交易。`);
        throw e;
      }
      if (!finalPosition?.sizeBase) {
        this._abortUndurableTransition('启动回收策略前确认仓位已为空，已停止且不会提交回收挂单。');
        throw new Error('该市场当前没有持仓，无需回收。');
      }
      this.running = true;
      try { this._criticalChanged(); }
      catch (e) {
        this._abortUndurableTransition('回收策略状态未能落盘，已停止且没有提交新的回收挂单。');
        throw e;
      }
      this.ex.on('fill', this._onFill);
      this.ex.on('price', this._onPrice);
      if (typeof this.ex.start === 'function') this.ex.start();
      const dir = finalPosition.sizeBase > 0 ? '多' : '空';
      const modeTxt = this.config.aboveEntryOnly ? '仅在成本价以上(不亏)分批减仓' : '任何反弹都分批减仓';
      this._alert(`已对 ${market.displayName} 的${dir}头 ${Math.abs(round6(pos.sizeBase))} 启用「只减仓回收阶梯」：${modeTxt}（只减不加、不自动止损，请自行控制风险）。`);
      // Confirm the market is now empty before submitting the new recovery
      // ladder. A stale/failed open-order response is a hard stop, never a reason
      // to stack a second ladder or relabel an unknown order as reduce-only.
      this._recoveryOccupied = new Set();
      try {
        if (typeof this.ex.fetchOpenOrders !== 'function') throw new Error('当前交易所不支持读取真实挂单');
        const remaining = await this.ex.fetchOpenOrders(market.marketId);
        if (!Array.isArray(remaining)) throw new Error('交易所未返回有效挂单列表');
        if (remaining.length) throw new Error(`撤单后仍检测到 ${remaining.length} 个无法证明为 reduce-only 的挂单`);
      }
      catch (e) {
        this._abortUndurableTransition(`启动回收策略前无法核对遗留挂单（${e?.message || e}），已锁定后续交易。`);
        throw e;
      }
      await this._manageRecoveryStandalone();
      this._startReconcileTimer(); // keep deduping/pruning the ladder while it runs
      this._finishDurableAction();
      return this.getState();
    } finally { this._starting = false; }
  }

  /** 市价平仓：撤销该市场全部挂单并立即市价平掉持仓。 */
  async closePositionNow(marketId) {
    return this._withMutation('close-position', () => this._closePositionNow(marketId));
  }

  async _closePositionNow(marketId) {
    const mId = Number(marketId ?? this.config?.marketId);
    if (!Number.isFinite(mId)) throw new Error('未指定市场，无法平仓。');
    if (!this.config?.displayName || Number(this.config.marketId) !== mId) {
      throw new Error('只能平当前已按名称确认的策略市场；已拒绝操作未绑定的 marketId。');
    }
    this._stopReconcileTimer();
    this._beginDurableStop('close-position', { marketId: mId });
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    try { requireExchangeSuccess(await this.ex.cancelAll(mId), '平仓前撤单'); }
    catch (e) { this._abortUndurableTransition(`平仓前撤单失败（${e?.message || e}）。`); throw e; }
    this.active.clear();
    this._retryQueue = [];
    this._deferredPlacements.clear();
    let closed = false;
    if (typeof this.ex.closePosition === 'function') {
      const confirmed = await this._closeWithConfirm(mId);
      if (!confirmed) { this._abortUndurableTransition('未能确认仓位已平，平仓操作仍待人工处理。'); throw new Error('未能确认仓位已平'); }
      closed = true;
    }
    this._alert(closed ? '已发送市价平仓指令并撤销该市场挂单（请在交易所确认已平）。' : '已撤销挂单（该交易所不支持自动平仓）。');
    this._finishDurableAction();
    return this.getState();
  }

  /**
   * Send a market close and CONFIRM the position is actually gone (polls the
   * adapter's position cache). Retries up to 3 times — an IOC close capped at a
   * worst-case price (±5%) can miss entirely when the market moves fast; each
   * retry re-prices from the latest mark. The old code fired once and hoped.
   */
  async _closeWithConfirm(marketId) {
    const mId = Number(marketId);
    if (typeof this.ex.closePosition !== 'function' || typeof this.ex.refreshPosition !== 'function') return false;
    let emptyStreak = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.ex.refreshPosition(mId);
        requireExchangeSuccess(await this.ex.closePosition(mId), '市价平仓');
      }
      catch (e) { this._alert('平仓指令发送失败: ' + (e?.message || e)); continue; }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { // wait for the adapter's position poll to reflect it
        let pos;
        try {
          pos = await this.ex.refreshPosition(mId);
        } catch (e) {
          emptyStreak = 0;
          this._alert('平仓后刷新仓位失败: ' + (e?.message || e));
          await sleep(1000);
          continue;
        }
        if (!pos || !pos.sizeBase) {
          emptyStreak += 1;
          if (emptyStreak >= 2) { this._alert('✅ 已连续确认仓位已平。'); return true; }
        } else {
          emptyStreak = 0;
        }
        await sleep(1000);
      }
      if (attempt < 3) this._alert(`⚠️ 平仓后仓位仍在（第 ${attempt} 次），按最新价重试市价平仓…`);
    }
    this._alert('❌ 已尝试 3 次平仓但仓位仍未平掉，请立即到交易所手动处理！');
    return false;
  }

  /** 独立回收阶梯：始终在现价的"下一档步进"处维持一排 reduce-only 退出单。 */
  async _manageRecoveryStandalone() {
    if (!this.running || !this.recovery || !this.config || !this._backgroundTradingAllowed()) return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) {
      // Require several CONSECUTIVE empty observations before declaring the
      // recovery finished — a single transient empty response from the position
      // endpoint (network blip) must not tear down the whole ladder.
      if (++this._noPosStreak >= 5) await this._finishRecovery();
      return;
    }
    this._noPosStreak = 0;
    const sp = this.config.spacing;
    if (!(sp > 0)) return;
    const long = pos.sizeBase > 0;
    // "只在入场价以上(不亏)减仓"：多头只在 >= 成本价挂卖，空头只在 <= 成本价挂买。
    const aboveEntry = !!this.config.aboveEntryOnly;
    const entry = Number(pos.entryPrice) || 0;
    // Rungs needed = enough to fully exit the CURRENT position (not a fixed 30).
    // As fills shrink the position, `need` shrinks too, so the ladder never
    // over-provisions. Hard ceiling guards against a pathological position/step.
    const HARD_MAX = 80;
    const perRung = this.config.sizeBase || (Math.abs(pos.sizeBase) / 20);
    const need = Math.min(HARD_MAX, Math.max(1, Math.ceil(Math.abs(pos.sizeBase) / perRung)));
    // Occupied = our tracked recovery levels UNION the exchange's real resting
    // levels (from reconcile). Using the real set means a spurious "order gone"
    // can't trick us into stacking a second order on a level that is still live.
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    for (const idx of this._recoveryOccupied) existing.add(idx);
    let placed = 0;
    if (long) {
      let lv = Math.ceil(price / sp) * sp; if (lv <= price) lv += sp;
      if (aboveEntry && entry > 0) { const eLv = Math.ceil(entry / sp) * sp; if (lv < eLv) lv = eLv; } // 不在成本价下方卖
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv += sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        await this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else {
      let lv = Math.floor(price / sp) * sp; if (lv >= price) lv -= sp;
      if (aboveEntry && entry > 0) { const eLv = Math.floor(entry / sp) * sp; if (lv > eLv) lv = eLv; } // 不在成本价上方买
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv -= sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        await this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) this._changed();
  }

  /** 持仓已减完 -> 结束回收。 */
  async _finishRecovery() {
    return this._withMutation('finish-recovery', () => this._finishRecoveryImpl());
  }

  async _finishRecoveryImpl() {
    if (!this.recovery) return;
    this._beginDurableStop('finish-recovery');
    this._stopReconcileTimer();
    this._recoveryOccupied = new Set();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    try { requireExchangeSuccess(await this.ex.cancelAll(this.config.marketId), '回收完成撤单'); }
    catch (e) {
      this._abortUndurableTransition(`回收完成时撤单失败（${e?.message || e}），已锁定后续交易。`);
      throw e;
    }
    this.active.clear();
    this._deferredPlacements.clear();
    this._alert('回收完成：持仓已全部减完，回收阶梯已停止。');
    this._finishDurableAction();
  }

  /**
   * Reconcile our tracking against the exchange's REAL open orders:
   *  - prune tracked orders no longer on the book (missed fills/cancels),
   *  - refill grid levels that have no resting order on the exchange.
   * "Occupied" levels are derived from the real order prices, so this is robust
   * even when our in-memory tracking has drifted.
   */
  async reconcileOpenOrders({ strict = false, withinMutation = false, allowResumeGate = false } = {}) {
    if (!withinMutation) {
      if (this._mutation) return false;
      return this._withMutation(
        'reconcile-orders',
        () => this._reconcileOpenOrders({ strict, allowResumeGate }),
        { allowBlocked: allowResumeGate },
      );
    }
    return this._reconcileOpenOrders({ strict, allowResumeGate });
  }

  async _reconcileOpenOrders({ strict = false, allowResumeGate = false } = {}) {
    if (!this.running || !this.config) return false;
    if (allowResumeGate) {
      if (!this._resumeGate || this._shuttingDown || (this._canTrade && !this._canTrade())) return false;
    } else if (!this._backgroundTradingAllowed()) return false;
    if (typeof this.ex.fetchOpenOrders !== 'function') {
      if (strict) throw new Error('当前交易所不支持读取真实挂单，无法安全去重');
      return false;
    }
    // Keep the adapter's price watch warm so a long-running market is never
    // pruned as "idle" (adapters drop unwatched markets after 10 min).
    if (!strict) this.ex.getPrice?.(this.config.marketId)?.catch?.(() => {});
    this._drainRetryQueue();
    const recovery = !!this.recovery;
    // Recovery has no grid: derive levels straight from price via config.spacing.
    const sp = recovery ? this.config.spacing : this.grid?.spacing;
    const lvl0 = recovery ? 0 : this.grid?.levels?.[0];
    if (!(sp > 0) || lvl0 == null) return;
    const nLevels = recovery ? Infinity : this.grid.levels.length;
    // Grid-mode recovery ladder (outOfRangeAction='recover') rests OUTSIDE the
    // grid: negative idx below the range, >= nLevels above. Widen the accepted
    // window so dedup/trim covers the ladder too (it used to be skipped, letting
    // duplicate ladder orders stack unchecked).
    const ladderPad = (!recovery && this.config.outOfRangeAction === 'recover') ? (this.grid?.count ?? 0) : 0;
    const idxLo = 0 - ladderPad, idxHi = nLevels === Infinity ? Infinity : nLevels + ladderPad;
    const trackedAtRequest = new Set(this.active.keys());
    let real;
    try { real = await this.ex.fetchOpenOrders(this.config.marketId); }
    catch (e) { if (strict) throw e; return false; }
    if (!Array.isArray(real)) {
      if (strict) throw new Error('交易所未返回有效挂单列表，无法安全去重');
      return false;
    }
    this._exchangeOpenOrders = real.length;
    // If an order was tracked when this request started but a fill event removed
    // it while the HTTP call was in flight, a response that still lists it is a
    // stale exchange snapshot. Never adopt that tombstoned id again.
    const staleFilledIds = new Set([
      ...this._terminalOrderIds.keys(),
      ...[...trackedAtRequest].filter((id) => !this.active.has(id)),
    ]);
    real = real.filter((o) => !staleFilledIds.has(String(o.orderId)));
    const realIds = new Set(real.map((o) => String(o.orderId)));
    const now = Date.now();

    if (strict) {
      for (const [oid, tracked] of this.active) {
        const actual = real.find((order) => String(order.orderId) === String(oid));
        if (!actual) {
          throw new Error(`本地订单 ${oid} 未出现在真实挂单列表，停机期间可能已成交或被撤，无法安全自动续跑`);
        }
        if (actual.metadataComplete !== true) {
          throw new Error(`真实挂单 ${oid} 缺少可验证的方向、价格、剩余量或 reduce-only 元数据，无法安全自动续跑`);
        }
        const expectedSize = Number(tracked.sizeBase ?? this.config.sizeBase);
        const actualSize = Number(actual.sizeBase);
        if (!sameResumeNumber(expectedSize, actualSize)) {
          throw new Error(`真实挂单 ${oid} 停机期间可能已部分成交：剩余量从 ${expectedSize} 变为 ${actualSize}，已拒绝猜测补单`);
        }
        const expectedReduceOnly = tracked.reduceOnly ?? (!!tracked.recovery || isReduceOnly(tracked.side, this.config.mode));
        const expectedExternalId = tracked.externalId == null ? null : String(tracked.externalId);
        const actualExternalId = actual.externalId == null ? null : String(actual.externalId);
        if (actual.side !== tracked.side
            || !sameResumeNumber(Number(tracked.price), Number(actual.price))
            || actual.reduceOnly !== expectedReduceOnly
            || (expectedExternalId != null && actualExternalId !== expectedExternalId)) {
          throw new Error(`真实挂单 ${oid} 的方向、价格、reduce-only 或稳定身份与快照不一致，已拒绝猜测式接管`);
        }
      }
    }

    // GUARD against transient bad snapshots: Extended's open-order endpoint has
    // been observed returning "0 orders" while dozens are really resting. An
    // all-vanished snapshot while we track many is overwhelmingly an API glitch
    // (real fills arrive via fill events anyway) — trusting it once wiped 78
    // tracked orders and orphaned them on the exchange. Skip pruning entirely on
    // such a snapshot, and in general require an order to be missing from TWO
    // consecutive reconciles before pruning it.
    const massVanish = real.length === 0 && this.active.size > 0;
    if (massVanish && strict) {
      throw new Error(`交易所返回 0 单，但本地仍跟踪 ${this.active.size} 单，无法信任本次对账结果`);
    }
    if (massVanish && now - (this._lastVanishAlertAt || 0) > 60000) {
      this._lastVanishAlertAt = now;
      this._alert(`⚠️ 挂单对账：交易所返回 0 单但本地跟踪 ${this.active.size} 单，疑似接口异常快照，本轮不清理（等待下轮复核）。`);
    }
    let pruned = 0;
    if (!massVanish) {
      for (const [oid, info] of [...this.active]) {
        if (realIds.has(oid)) { info.goneRecon = 0; continue; }
        if (now - (info.placedAt || 0) <= PRUNE_GRACE_MS) continue;
        info.goneRecon = (info.goneRecon || 0) + 1;
        if (info.goneRecon >= 2) { this.active.delete(oid); pruned++; }
      }
    }

    // Map real orders to levels. Cancel any DUPLICATE resting order on a level so
    // we converge to one-order-per-level. A true orphan on an otherwise empty
    // level is never guessed into this strategy: exchange rows cannot prove the
    // durable opening/closing intent (especially in neutral mode), and a partial
    // order's remaining quantity may differ from config.sizeBase.
    const occupied = new Set();
    // Exchange APIs do not promise a stable order. Process already-tracked
    // orders first so the survivor on each level is deterministic and remains
    // attached to fill handling; any untracked duplicate is then cancelled.
    const orderedReal = [...real].sort((a, b) => {
      const aTracked = this.active.has(String(a.orderId)) ? 1 : 0;
      const bTracked = this.active.has(String(b.orderId)) ? 1 : 0;
      return bTracked - aTracked;
    });
    let trimmed = 0, adopted = 0;
    for (const o of orderedReal) {
      const oid = String(o.orderId);
      const trackedInfo = this.active.get(oid);
      const px = Number(o.price);
      const inferredIdx = Number.isFinite(px) && sp > 0 ? Math.round((px - lvl0) / sp) : null;
      const unknownRecoveryOrder = !trackedInfo && (
        recovery || (!recovery && this.config.outOfRangeAction === 'recover'
          && (inferredIdx == null || inferredIdx < 0 || inferredIdx >= nLevels))
      );
      if (unknownRecoveryOrder) {
        const message = `回收模式检测到无法证明为 reduce-only 的未跟踪挂单 ${o.orderId}，已锁定自动交易`;
        if (!this.pendingAction) this._beginDurableAction('verify-recovery-orders', { orderId: String(o.orderId) });
        this.blockTrading(message);
        this._changed();
        throw new Error(message);
      }
      if ((!Number.isFinite(px) || !(sp > 0)) && !trackedInfo) {
        const message = `检测到无法证明属于当前策略的未跟踪挂单 ${o.orderId}（价格/身份不完整），已锁定自动交易`;
        if (!this.pendingAction) this._beginDurableAction('verify-orphan-order', { orderId: oid });
        this.blockTrading(message); this._changed();
        throw new Error(message);
      }
      if (!Number.isFinite(px) || !(sp > 0)) continue;
      // A tracked order may intentionally be off the new grid (for example an
      // old-grid fill's protective exit while adjustRange was cancelling).
      // Preserve its durable logical level; only infer levels for true orphans.
      const idx = Number.isInteger(trackedInfo?.levelIndex)
        ? trackedInfo.levelIndex
        : inferredIdx;
      if (!(idx >= idxLo && idx < idxHi)) {
        if (!trackedInfo) {
          const message = `检测到无法证明属于当前策略的未跟踪挂单 ${o.orderId}（不在可接管网格档位），已锁定自动交易`;
          if (!this.pendingAction) this._beginDurableAction('verify-orphan-order', { orderId: oid });
          this.blockTrading(message); this._changed();
          throw new Error(message);
        }
        continue;
      }
      if (!occupied.has(idx)) {
        if (!trackedInfo) {
          const message = `检测到无法证明属于当前策略的未跟踪挂单 ${o.orderId}，已锁定自动交易`;
          if (!this.pendingAction) this._beginDurableAction('verify-orphan-order', { orderId: oid });
          this.blockTrading(message); this._changed();
          throw new Error(message);
        }
        occupied.add(idx);
        continue;
      }
      if (allowResumeGate) {
        const message = `恢复安全核验发现同档重复挂单 ${o.orderId}，已保留交易所原单并锁定自动交易`;
        this.blockTrading(message);
        this._changed();
        throw new Error(message);
      }
      const ownsIntent = !this.pendingAction;
      try {
        if (ownsIntent) this._beginDurableAction('reconcile-cancel-duplicate', { orderId: String(o.orderId) });
        requireExchangeSuccess(await this.ex.cancelOrder(this.config.marketId, o.orderId, { externalId: o.externalId }), '撤销重复挂单');
        this.active.delete(String(o.orderId)); trimmed++;
        if (ownsIntent) this._finishDurableAction();
      } catch (e) {
        if (ownsIntent) this._abortUndurableTransition(`对账撤销重复挂单失败（${e?.message || e}），已锁定后续交易。`);
        if (strict || ownsIntent) throw e;
      }
    }
    if (recovery) this._recoveryOccupied = occupied;

    // IMPORTANT: reconciliation no longer re-seeds opening orders. Re-seeding via
    // seedOrders re-opened a SAME-SIDE order on a level that a fill had just
    // (correctly) vacated — its take-profit order lives one rung away — which made
    // the grid open positions endlessly in one direction (runaway inventory).
    // The grid is now maintained ONLY by the normal fill -> opposite-leg
    // replacement chain. Reconcile just keeps tracking accurate (prune) and
    // enforces one-order-per-level (trim). It never opens new positions.
    if (pruned || trimmed || adopted) {
      this._alert(`挂单对账：交易所实际 ${real.length} 单；清理失效 ${pruned}，撤除重复 ${trimmed}${adopted ? `，接管 ${adopted}` : ''}。`);
      if (adopted) {
        try { this._criticalChanged(); }
        catch (e) {
          this._abortUndurableTransition(`已接管交易所遗留挂单，但接管状态未能可靠落盘（${e?.message || e}）。`);
          throw e;
        }
      }
      this._changed();
    }
    return true;
  }

  _startReconcileTimer() {
    if (this._reconTimer) return;
    this._reconTimer = setInterval(() => { this.reconcileOpenOrders().catch(() => {}); }, RECONCILE_MS);
    this._reconTimer.unref?.();
  }
  _stopReconcileTimer() { if (this._reconTimer) { clearInterval(this._reconTimer); this._reconTimer = null; } }

  _alert(message) {
    this.alerts.unshift({ t: Date.now(), message });
    if (this.alerts.length > 30) this.alerts.pop();
  }

  /** Per-exchange health classification surfaced to the dashboard. */
  _health() {
    const ex = this.ex;
    const okAge = (typeof ex.lastOkAt === 'number' && ex.lastOkAt > 0) ? Date.now() - ex.lastOkAt : null;
    const priceStale = !!(ex._pxStale && this.config && typeof ex._pxStale.has === 'function' && ex._pxStale.has(this.config.marketId));
    const recentFail = this._lastFailAt && (Date.now() - this._lastFailAt < 60000);
    const paused = this._refillPausedUntil && Date.now() < this._refillPausedUntil;
    let status = 'ok', reason = '正常运行';
    const operationalBlock = this.getOperationalBlock();
    if (operationalBlock) { status = 'error'; reason = operationalBlock; }
    else if (!this.running && !this.config) { status = 'idle'; reason = '未运行'; }
    else if (paused) { status = 'error'; reason = `订单频繁被取消（疑似保证金不足），已暂停补单 ${Math.ceil((this._refillPausedUntil - Date.now())/1000)}s`; }
    else if (ex.dataSource === 'synthetic') { status = 'warn'; reason = '合成行情（未连真实交易所）'; }
    else if (okAge != null && okAge > 30000) { status = 'error'; reason = `交易所数据 ${Math.round(okAge / 1000)}s 未更新`; }
    else if (priceStale) { status = 'warn'; reason = '行情滞后（已用持仓推算价兜底）'; }
    else if (recentFail) { status = 'warn'; reason = `近1分钟下单失败 ${this._placeFails} 次`; }
    return {
      status, reason,
      dataSource: ex.dataSource ?? null,
      lastOkAgeMs: okAge,
      priceStale,
      placeFails: this._placeFails,
      exchangeOpenOrders: this._exchangeOpenOrders,
    };
  }

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const openByLevel = {};
    for (const o of this.active.values()) openByLevel[o.levelIndex] = o.side;

    const unrealized = pos ? round2(pos.unrealizedPnl) : 0;
    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;
    const equityRaw = typeof this.ex.equity === 'number' ? this.ex.equity
      : (balance != null ? balance + unrealized : null);
    const equity = equityRaw != null ? round2(equityRaw) : null;

    let realized;
    if (typeof this.ex.realizedPnl === 'number') {
      realized = round2(this.ex.realizedPnl - (this._pnlBase ?? 0)); // offset applied by resetStats
    } else if (equityRaw != null && this.startBalance != null) {
      realized = round2((equityRaw - this.startBalance) - unrealized);
    } else {
      realized = round2(this.stats.gridProfit);
    }
    const totalPnl = round2(realized + unrealized);
    const returnPct = (this.startBalance && this.startBalance > 0)
      ? round2((totalPnl / this.startBalance) * 100)
      : ((equity && equity > 0) ? round2((totalPnl / equity) * 100) : null);
    return {
      mode: this.ex.mode,
      recovery: this.recovery,
      running: this.running,
      config: this.config,
      grid: this.grid,
      lastPrice: this.lastPrice != null ? round2(this.lastPrice) : null,
      outOfRange: this.outOfRange,
      risk: this.risk,
      stats: this.stats,
      openOrders: this.active.size,
      exchangeOpenOrders: this._exchangeOpenOrders,
      openByLevel,
      health: this._health(),
      tradingBlock: this.tradingBlock,
      pendingAction: this.pendingAction,
      pendingOrderCount: this.pendingOrders.size,
      position: pos ? { sizeBase: round6(pos.sizeBase), entryPrice: round2(pos.entryPrice), unrealizedPnl: round2(pos.unrealizedPnl), leverage: pos.leverage ?? null } : null,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct,
      equity,
      balance,
      volume: this.stats.volume,
      theoreticalProfit: round2(this.stats.gridProfit),
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
    };
  }
}

function labelMode(m) { return m === 'long' ? '做多网格' : m === 'short' ? '做空网格' : '中性网格'; }

function normalizeMarketName(x) { return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function buildPositionExitOrders({ position, levels, price, mode, defaultSize }) {
  const signedSize = Number(position?.sizeBase);
  if (!Number.isFinite(signedSize) || signedSize === 0) return [];
  if ((mode === 'long' && signedSize < 0) || (mode === 'short' && signedSize > 0)) {
    throw new Error(`当前持仓方向与${mode === 'long' ? '做多' : '做空'}网格不一致，已拒绝调整区间。`);
  }
  const long = signedSize > 0;
  const candidates = levels
    .map((levelPrice, levelIndex) => ({ levelIndex, price: levelPrice }))
    .filter((level) => long ? level.price > price : level.price < price)
    .sort((a, b) => long ? a.price - b.price : b.price - a.price);
  if (!candidates.length) {
    throw new Error('新区间没有可安全挂出持仓退出单的价位，已拒绝调整区间。');
  }
  const total = Math.abs(signedSize);
  const rungSize = Number(defaultSize) > 0 ? Number(defaultSize) : total;
  const count = Math.min(candidates.length, Math.max(1, Math.ceil(total / rungSize)));
  let remaining = total;
  return candidates.slice(0, count).map((level, index) => {
    const sizeBase = index === count - 1 ? remaining : Math.min(rungSize, remaining);
    remaining -= sizeBase;
    return {
      ...level,
      side: long ? 'sell' : 'buy',
      sizeBase,
      opening: false,
      reduceOnly: true,
    };
  });
}

function isValidPaperExchangeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.version !== 1) return false;
  if (!Number.isFinite(state.balance) || !Number.isFinite(state.realizedPnl)) return false;
  if (!Number.isInteger(state.seq) || state.seq < 1 || !Array.isArray(state.positions)) return false;
  return state.positions.every((position) => position && typeof position === 'object'
    && typeof position.marketName === 'string' && position.marketName.trim().length > 0
    && Number.isFinite(position.sizeBase) && position.sizeBase !== 0
    && Number.isFinite(position.entryPrice) && position.entryPrice > 0);
}

function unsafeResumeError(message) {
  return Object.assign(new Error(message), { code: 'UNSAFE_RESUME' });
}

function sameResumeNumber(expected, actual) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-8);
  return Math.abs(expected - actual) <= tolerance;
}

function requireExchangeSuccess(result, action) {
  if (result === false || result?.success === false) throw new Error(`${action}未被交易所确认成功`);
  return result;
}

function restoreRetryQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((order) => order && typeof order === 'object'
    && Number.isInteger(order.levelIndex) && ['buy', 'sell'].includes(order.side)
    && Number.isFinite(order.price) && Number.isFinite(order.sizeBase) && order.sizeBase > 0)
    .map((order) => ({ ...order, _nextAt: Math.max(Date.now(), Number(order._nextAt) || Date.now()) }));
}

function validateRetryQueue(value) {
  if (value == null) return;
  const restored = restoreRetryQueue(value);
  if (!Array.isArray(value) || restored.length !== value.length
      || restored.some((order) => order.opening !== false && !order.reduceOnly && !order.recovery)) {
    throw unsafeResumeError('网格快照中的待重试平仓单不完整，已拒绝自动续跑。');
  }
}

function validateDeferredPlacements(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw unsafeResumeError('网格快照中的待补挂订单格式错误，已拒绝自动续跑。');
  const ids = new Set();
  const entries = value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry[1] || typeof entry[1] !== 'object') {
      throw unsafeResumeError('网格快照中的待补挂订单格式错误，已拒绝自动续跑。');
    }
    const id = String(entry[0] || '');
    const order = entry[1];
    if (!id || ids.has(id) || !Number.isInteger(order.levelIndex)
        || !['buy', 'sell'].includes(order.side) || !Number.isFinite(order.price) || order.price <= 0
        || (order.sizeBase != null && (!Number.isFinite(order.sizeBase) || order.sizeBase <= 0))
        || ['opening', 'reduceOnly', 'recovery'].some((key) => order[key] != null && typeof order[key] !== 'boolean')) {
      throw unsafeResumeError('网格快照中的待补挂订单不完整，已拒绝自动续跑。');
    }
    ids.add(id);
    return [id, { ...order }];
  });
  return entries;
}

function restoreTerminalOrderIds(value, fills = []) {
  const restored = new Map();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const id = String(entry[0] || '');
      const at = Number(entry[1]);
      if (id && Number.isFinite(at) && at >= 0) restored.set(id, at);
    }
  }
  // Backward compatibility for snapshots written just before tombstones were
  // introduced: recent fills already carry orderId and are safe to promote.
  for (const fill of fills) {
    const id = String(fill?.orderId || '');
    if (id && !restored.has(id)) restored.set(id, Number(fill?.t) || 0);
  }
  while (restored.size > TERMINAL_ORDER_LIMIT) restored.delete(restored.keys().next().value);
  return restored;
}

function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
