// Regression tests for deployment-safe grid state persistence.
// Each "release" has an ephemeral application root; only data/ is retained.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GridBot } from '../src/bot.js';
import { DecibelExchange } from '../src/exchange/de/decibel.js';
import { PaperExchange as DePaperExchange } from '../src/exchange/de/paper.js';
import { PaperExchange as ExPaperExchange } from '../src/exchange/ex/paper.js';
import { ExtendedExchange } from '../src/exchange/ex/extended.js';
import { PaperExchange as RsPaperExchange } from '../src/exchange/rs/paper.js';
import { RisexExchange } from '../src/exchange/rs/risex.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-state-deploy-'));

function makeRelease(name) {
  const root = path.join(fixtureRoot, name);
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.copyFileSync(path.join(projectRoot, 'src', 'config.js'), path.join(src, 'config.js'));
  fs.copyFileSync(path.join(projectRoot, 'src', 'persist.js'), path.join(src, 'persist.js'));
  return root;
}

async function loadStore(root) {
  return import(pathToFileURL(path.join(root, 'src', 'persist.js')).href);
}

function retainDataOnly(from, to) {
  fs.rmSync(path.join(to, 'data'), { recursive: true, force: true });
  fs.cpSync(path.join(from, 'data'), path.join(to, 'data'), { recursive: true });
}

const runningGrid = {
  running: true,
  exchangeMode: 'live',
  config: {
    marketId: 7, displayName: 'BTC-USD', mode: 'neutral', lower: 60000,
    upper: 70000, gridCount: 10, sizeBase: 0.001, leverage: 3,
  },
  stats: { completedRungs: 3, volume: 1234.5 },
  active: [['order-1', { levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001 }]],
  fills: [{ t: 123, side: 'buy', price: 62000, size: 0.001, level: 2 }],
  alerts: [{ t: 124, message: '网格运行中' }],
};

try {
  {
    const releaseA = makeRelease('release-a');
    const storeA = await loadStore(releaseA);
    assert.equal(storeA.saveSnapshot('de', runningGrid, { immediate: true }), true);

    const releaseB = makeRelease('release-b');
    retainDataOnly(releaseA, releaseB);
    const storeB = await loadStore(releaseB);

    assert.deepEqual(
      storeB.loadSnapshot('de'),
      runningGrid,
      '重新部署只保留 data/ 卷时，运行中的网格快照必须仍可读取',
    );
    console.log('  ✓ running grid survives a data-volume-only redeploy');
  }

  {
    const releaseA = makeRelease('critical-release-a');
    const storeA = await loadStore(releaseA);
    assert.equal(
      storeA.saveSnapshot('de', { ...runningGrid, active: [] }, { immediate: true }),
      true,
      '首次向交易所下单前，running 状态必须同步落盘',
    );
    const releaseB = makeRelease('critical-release-b');
    retainDataOnly(releaseA, releaseB);
    const storeB = await loadStore(releaseB);
    assert.equal(storeB.loadSnapshot('de')?.running, true, '500ms 防抖窗口内硬崩后也必须看到可恢复状态');
    console.log('  ✓ critical running transition is durable before any order side effect');
  }

  {
    const releaseA = makeRelease('legacy-release-a');
    fs.writeFileSync(path.join(releaseA, '.state.json'), JSON.stringify({ ex: runningGrid }));
    const storeA = await loadStore(releaseA);
    assert.deepEqual(storeA.loadSnapshot('ex'), runningGrid, '升级时必须读取旧版 .state.json');
    assert.ok(fs.existsSync(path.join(releaseA, 'data', 'grid-state.json')), '读取旧快照时必须立即迁入 data/');
    assert.ok(fs.existsSync(path.join(releaseA, 'data', '.legacy-state-migrated')), '必须记录旧快照已迁移，避免挂载文件无法归档时被再次导入');
    assert.equal(fs.existsSync(path.join(releaseA, '.state.json')), false, '迁移后必须归档旧快照，防止重置时复活过期网格');
    assert.equal(
      fs.readdirSync(releaseA).some((name) => name.startsWith('.state.json.bak-migrated-')),
      true,
      '旧快照应保留为不再自动读取的迁移备份',
    );

    const releaseB = makeRelease('legacy-release-b');
    retainDataOnly(releaseA, releaseB);
    const storeB = await loadStore(releaseB);
    assert.deepEqual(
      storeB.loadSnapshot('ex'),
      runningGrid,
      '旧版 .state.json 必须迁入 data/，下一次部署后不能再次丢失',
    );

    const resetRelease = makeRelease('legacy-reset-release');
    retainDataOnly(releaseA, resetRelease);
    fs.rmSync(path.join(resetRelease, 'data', 'grid-state.json'));
    fs.writeFileSync(path.join(resetRelease, '.state.json'), JSON.stringify({ ex: runningGrid }));
    const resetStore = await loadStore(resetRelease);
    assert.throws(
      () => resetStore.loadSnapshot('ex'),
      /检测到旧快照迁移标记.*程序已中止启动/,
      '新快照异常消失时必须中止，既不能复活旧网格也不能伪装成空状态',
    );
    console.log('  ✓ legacy root snapshot migrates into the persistent data volume');
  }

  {
    const release = makeRelease('corrupt-release');
    fs.writeFileSync(path.join(release, 'data', 'grid-state.json'), '{"de":');
    const store = await loadStore(release);
    assert.throws(
      () => store.loadSnapshot('de'),
      /程序已中止启动.*核对交易所挂单和仓位/,
      '损坏的持久化快照必须阻止启动，不能伪装成首次运行',
    );
    console.log('  ✓ corrupt state fails closed instead of hiding a running grid');
  }

  {
    const releaseA = makeRelease('mounted-legacy-release-a');
    const legacyFile = path.join(releaseA, '.state.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ rs: runningGrid }));
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(String(from)) === '.state.json' && String(to).includes('.bak-migrated-')) {
        const error = new Error('injected EBUSY'); error.code = 'EBUSY'; throw error;
      }
      return originalRename(from, to);
    };
    try {
      const storeA = await loadStore(releaseA);
      assert.deepEqual(storeA.loadSnapshot('rs'), runningGrid);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.ok(fs.existsSync(legacyFile), '单文件挂载点无法归档时，旧快照会留在原位');
    assert.ok(fs.existsSync(path.join(releaseA, 'data', '.legacy-state-migrated')), '归档失败时迁移标记仍须落盘');

    const releaseB = makeRelease('mounted-legacy-release-b');
    retainDataOnly(releaseA, releaseB);
    fs.rmSync(path.join(releaseB, 'data', 'grid-state.json'));
    fs.copyFileSync(legacyFile, path.join(releaseB, '.state.json'));
    const storeB = await loadStore(releaseB);
    assert.throws(
      () => storeB.loadSnapshot('rs'),
      /检测到旧快照迁移标记.*程序已中止启动/,
      '旧文件无法归档且新快照消失时，必须阻止过期网格复活并显式中止',
    );
    console.log('  ✓ migration marker protects file-mount deployments from stale revival');
  }

  {
    const release = makeRelease('read-only-data-release');
    fs.writeFileSync(path.join(release, 'data', 'grid-state.json'), JSON.stringify({ de: runningGrid }));
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === 'grid-state.json') {
        const error = new Error('injected EBUSY'); error.code = 'EBUSY'; throw error;
      }
      return originalRename(from, to);
    };
    try {
      const store = await loadStore(release);
      assert.throws(
        () => store.loadSnapshot('de'),
        /可读但无法安全覆写.*程序已中止启动/,
        '快照虽可读但持久卷不可写时必须阻止启动',
      );
    } finally {
      fs.renameSync = originalRename;
    }
    console.log('  ✓ an unwritable/single-file state mount fails at startup');
  }

  {
    const release = makeRelease('runtime-failure-release');
    const store = await loadStore(release);
    assert.equal(store.saveSnapshot('de', { ...runningGrid, stats: { completedRungs: 1 } }, { immediate: true }), true);
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === 'grid-state.json') {
        const error = new Error('injected EIO'); error.code = 'EIO'; throw error;
      }
      return originalRename(from, to);
    };
    try {
      assert.equal(store.saveSnapshot('de', { ...runningGrid, stats: { completedRungs: 9 } }, { immediate: true }), false);
      assert.equal(store.getPersistenceHealth().ok, false);
      assert.equal(store.getPersistenceHealth().dirty, true);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(store.flushNow(), true, '磁盘恢复后必须能重试最新状态');
    assert.equal(store.getPersistenceHealth().ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(release, 'data', 'grid-state.json'))).de.stats.completedRungs, 9);
    console.log('  ✓ runtime persistence failures are visible and retry the latest snapshot');
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

class ResumeExchange extends EventEmitter {
  constructor() {
    super();
    this.mode = 'live';
    this.dataSource = 'real';
    this.balance = 10000;
    this.adopted = [];
  }

  adoptOrder(order) { this.adopted.push(order); }
  start() {}
  async getMarkets() { return [{ marketId: 7, displayName: 'BTC-USD' }]; }
  async getPrice(_marketId, opts = {}) {
    assert.equal(opts.requireFresh, true, '恢复续跑必须显式要求实时行情，不能退回进程缓存');
    return 65000;
  }
  getPosition() { return null; }
  async fetchOpenOrders() {
    return this.adopted.map((o) => ({
      orderId: o.orderId, price: o.price, side: o.side, sizeBase: o.sizeBase,
      reduceOnly: !!o.reduceOnly, metadataComplete: true,
      ...(o.externalId != null ? { externalId: o.externalId } : {}),
    }));
  }
}

{
  const exchange = new DecibelExchange({ apiKey: 'test', privateKey: '1', subaccount: '0x1' });
  exchange.markets.set(7, {
    marketId: 7, name: 'BTC-USD', displayName: 'BTC-USD', addr: '0xbtc',
    pxDecimals: 0, lastPrice: 62000,
  });
  exchange._openOrders = async () => [{
    order_id: 'de-partial', market: '0xbtc', is_buy: true, price: 62000,
    remaining_size: 0.25, is_reduce_only: true, client_order_id: 'client-7',
  }];

  assert.deepEqual(await exchange.fetchOpenOrders(7), [{
    orderId: 'de-partial', clientOrderId: 'client-7', price: 62000, side: 'buy',
    sizeBase: 0.25, reduceOnly: true, metadataComplete: true,
  }]);
  exchange._openOrders = async () => [{
    order_id: 'de-unknown', market: '0xbtc', is_buy: true, price: 62000,
    remaining_size: null,
  }];
  assert.equal((await exchange.fetchOpenOrders(7))[0].metadataComplete, false);
  console.log('  ✓ Decibel open orders preserve remaining size and reduce-only identity');
}

{
  const exchange = new DecibelExchange({ apiKey: 'test', privateKey: '1', subaccount: '0x1' });
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    order_id: `page-1-${index}`, market: '0xbtc',
  }));
  const offsets = [];
  exchange.read = { userOpenOrders: { getByAddr: async ({ offset }) => {
    offsets.push(offset);
    return offset === 0 ? firstPage : [{ order_id: 'page-2', market: '0xbtc' }];
  } } };

  const rows = await exchange._openOrders();
  assert.equal(rows.length, 501);
  assert.deepEqual(offsets, [0, 500], '首屏满载时必须继续读取下一页挂单');
  console.log('  ✓ Decibel open-order reads are complete across pagination');
}

{
  const exchange = new DecibelExchange({ apiKey: 'test', privateKey: '1', subaccount: '0x1' });
  exchange.markets.set(7, {
    marketId: 7, name: 'BTC-USD', displayName: 'BTC-USD', addr: '0xbtc',
    pxDecimals: 0, lastPrice: 62000,
  });
  exchange.read = {
    marketPrices: { getByName: async () => ({ mid_px: 50000, transaction_unix_ms: Date.now() - 60000 }) },
    candlesticks: { getByName: async () => [{ T: Date.now() - 240000, c: 50000 }] },
  };

  assert.equal(
    await exchange.getPrice(7, { requireFresh: true }),
    null,
    '数分钟前的 K 线不能冒充恢复续跑所需的实时价',
  );
  const now = Date.now();
  exchange.read.candlesticks.getByName = async () => [
    { T: now - 5_000, c: 51000 },
    { T: now - 30_000, c: 50500 },
  ];
  assert.equal(
    await exchange.getPrice(7, { requireFresh: true }),
    51000,
    'K 线响应无序时必须按时间戳选取最新价格',
  );
  console.log('  ✓ Decibel requireFresh rejects stale candle fallbacks');
}

{
  const exchange = new RsPaperExchange({ apiUrl: 'https://risex.test' });
  exchange.dataSource = 'real';
  exchange.prices.set(1, 60000);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        data: { data: [
          { time: '1700000000000000000', open: '60000', high: '60100', low: '59900', close: '60050', volume: '12.5' },
          { time: '1700003600000000000', open: '60050', high: '60200', low: '60000', close: '60150', volume: '18.75' },
        ] },
      };
    },
  });
  try {
    const candles = await exchange.getCandles(1, 3600, 200);
    assert.equal(candles.length, 2, 'RISEx paper 必须解析真实接口的 data.data K 线，而不是静默回退 200 根合成数据');
    assert.deepEqual(candles[0], {
      time: 1700000000000, open: 60000, high: 60100, low: 59900, close: 60050, volume: 12.5,
    });
  } finally {
    global.fetch = originalFetch;
  }
  console.log('  ✓ RISEx paper parses nested real candlestick responses');
}

{
  const exchange = new DecibelExchange({
    apiKey: 'test', privateKey: '1', subaccount: '0x1',
    cancelConfirmDelayMs: 0, cancelConfirmAttempts: 4,
  });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD', addr: '0xbtc' });
  const individuallyCancelled = [];
  let openReads = 0;
  exchange.write = {
    cancelOrder: async ({ orderId }) => { individuallyCancelled.push(String(orderId)); return { success: true }; },
    cancelBulkOrder: async () => { throw new Error('bulk state is not ordinary-order cancellation'); },
  };
  exchange._tracked.set('de-order', { marketId: 7 });
  exchange._openOrders = async () => {
    openReads += 1;
    return openReads === 1
      ? [{ order_id: 'de-order', market: '0xbtc', is_buy: true, price: 62000 }]
      : [];
  };

  assert.equal(await exchange.cancelAll(7), true);
  assert.deepEqual(individuallyCancelled, ['de-order'], 'Decibel 普通 GTC 单必须逐单调用 cancelOrder');
  assert.ok(openReads >= 4, '撤单后必须连续确认真实挂单为空');
  assert.equal(exchange._tracked.has('de-order'), false);

  const failed = new DecibelExchange({
    apiKey: 'test', privateKey: '1', subaccount: '0x1',
    cancelConfirmDelayMs: 0, cancelConfirmAttempts: 3,
  });
  failed.markets.set(7, { marketId: 7, name: 'BTC-USD', addr: '0xbtc' });
  failed.write = { cancelOrder: async () => null };
  failed._openOrders = async () => [{ order_id: 'still-live', market: '0xbtc' }];
  failed._tracked.set('still-live', { marketId: 7 });
  assert.equal(await failed.cancelAll(7), false, '未确认链上撤单成功时必须 fail closed');
  assert.equal(failed._tracked.has('still-live'), true);

  const falseEmpty = new DecibelExchange({
    apiKey: 'test', privateKey: '1', subaccount: '0x1',
    cancelConfirmDelayMs: 0, cancelConfirmAttempts: 5,
  });
  falseEmpty.markets.set(7, { marketId: 7, name: 'BTC-USD', addr: '0xbtc' });
  const lateCancels = [];
  falseEmpty.write = { cancelOrder: async ({ orderId }) => {
    lateCancels.push(String(orderId));
    return { success: true };
  } };
  let falseEmptyReads = 0;
  falseEmpty._openOrders = async () => {
    falseEmptyReads += 1;
    return falseEmptyReads === 2 ? [{ order_id: 'late-indexed', market: '0xbtc' }] : [];
  };
  assert.equal(await falseEmpty.cancelAll(7), true);
  assert.deepEqual(lateCancels, ['late-indexed'], '首次假空后出现的普通单也必须被撤销');
  assert.ok(falseEmptyReads >= 5, '晚出现订单后必须重新累计连续空盘口确认');
  console.log('  ✓ Decibel cancels ordinary GTC orders individually and confirms the real book');
}

{
  const exchange = new DecibelExchange({ apiKey: 'test', privateKey: '1', subaccount: '0x1' });
  const historyOffsets = [];
  exchange.read = { userOrderHistory: { getByAddr: async ({ offset }) => {
    historyOffsets.push(offset);
    if (offset === 0) {
      return Array.from({ length: 100 }, (_, index) => ({
        order_id: `older-${index}`, status: 'CANCELLED',
      }));
    }
    return [{ order_id: 'de-history-page-2', status: 'CANCELLED' }];
  } } };
  exchange.on('error', () => {});
  exchange._tracked.set('de-history-page-2', {
    marketId: 7, side: 'buy', price: 62000, sizeBase: 1, goneAttempts: 5,
  });

  await exchange._resolveGone('de-history-page-2', exchange._tracked.get('de-history-page-2'));

  assert.deepEqual(historyOffsets, [0, 100]);
  assert.equal(exchange._tracked.has('de-history-page-2'), false, '第二页终态记录必须被读取并处理');
  console.log('  ✓ Decibel gone-order resolution paginates order history');
}

{
  const exchange = new ExtendedExchange({ apiKey: 'test', vault: '1', privateKey: '1' });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  exchange._get = async () => [{
    id: 12345678901234568000,
    externalId: '123456789012345678901234567890',
    market: 'BTC-USD', type: 'LIMIT', status: 'PARTIALLY_FILLED', side: 'SELL',
    price: '62000', qty: '1', filledQty: '0.75', reduceOnly: true,
  }];

  assert.deepEqual(await exchange.fetchOpenOrders(7), [{
    orderId: String(12345678901234568000), externalId: '123456789012345678901234567890',
    price: 62000, side: 'sell', sizeBase: 0.25, reduceOnly: true, metadataComplete: true,
  }]);
  exchange._get = async () => [{
    id: 2, externalId: 'partial-without-filled-qty', market: 'BTC-USD',
    type: 'LIMIT', status: 'PARTIALLY_FILLED', side: 'BUY',
    price: '62000', qty: '1', reduceOnly: false,
  }];
  const partialWithoutQuantity = (await exchange.fetchOpenOrders(7))[0];
  assert.equal(partialWithoutQuantity.sizeBase, null);
  assert.equal(
    partialWithoutQuantity.metadataComplete,
    false,
    'PARTIALLY_FILLED 缺少 filledQty 时不能猜成零成交并自动接管',
  );
  exchange._get = async () => [{
    id: 1, externalId: 'bad', market: 'BTC-USD', type: 'TWAP', status: 'NEW',
    side: 'SIDEWAYS', price: '62000', qty: '1', reduceOnly: undefined,
  }];
  assert.equal((await exchange.fetchOpenOrders(7))[0].metadataComplete, false);
  exchange._get = async () => [{
    externalId: null, market: 'BTC-USD', side: 'BUY', price: '62000', qty: '1',
    filledQty: '0', reduceOnly: false,
  }];
  const malformed = (await exchange.fetchOpenOrders(7))[0];
  assert.equal(malformed.orderId, null);
  assert.equal(malformed.metadataComplete, false, '缺必填 id/type/status 的响应不能被当作可接管挂单');
  console.log('  ✓ Extended open orders preserve precise identity and true remaining quantity');
}

{
  const exchange = new ExtendedExchange({
    apiKey: 'test', vault: '1', privateKey: '1', cancelConfirmDelayMs: 0, cancelConfirmAttempts: 4,
  });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  exchange._tracked.set('old', {
    marketId: 7, externalId: 'exact-old', side: 'buy', price: 62000, sizeBase: 1,
  });
  let reads = 0;
  exchange._req = async (method) => {
    if (method !== 'GET') return null; // cancellation request accepted asynchronously
    reads += 1;
    return reads < 3
      ? [{ id: 1, externalId: 'exact-old', market: 'BTC-USD', type: 'LIMIT', status: 'NEW', side: 'BUY', price: '62000', qty: '1', filledQty: '0', reduceOnly: false }]
      : [];
  };

  assert.equal(await exchange.cancelAll(7), true, '异步批量撤单必须等待盘口连续确认为空');
  assert.ok(reads >= 4, '一次空快照不足以确认 Extended 已完成撤单');
  assert.equal(exchange._tracked.has('old'), false);

  const stuck = new ExtendedExchange({
    apiKey: 'test', vault: '1', privateKey: '1', cancelConfirmDelayMs: 0, cancelConfirmAttempts: 3,
  });
  stuck.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  stuck._tracked.set('old', { marketId: 7, externalId: 'exact-old' });
  stuck._req = async (method) => method === 'GET'
    ? [{ id: 1, externalId: 'exact-old', market: 'BTC-USD', type: 'LIMIT', status: 'NEW', side: 'BUY', price: '62000', qty: '1', filledQty: '0', reduceOnly: false }]
    : null;
  assert.equal(await stuck.cancelAll(7), false, '撤单请求已受理但订单仍在时不得报告成功');
  assert.equal(stuck._tracked.has('old'), true, '未确认撤完时必须保留本地跟踪');

  const malformed = new ExtendedExchange({
    apiKey: 'test', vault: '1', privateKey: '1', cancelConfirmDelayMs: 0, cancelConfirmAttempts: 2,
  });
  malformed.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  malformed._tracked.set('server-old', { marketId: 7, externalId: 'exact-old' });
  malformed._req = async (method) => method === 'GET'
    ? [{ id: 'server-old', market: 'BTC-USD', type: 'LIMIT', status: 'NEW', side: 'BUY', price: '62000', qty: '1', filledQty: '0', reduceOnly: false }]
    : null;
  assert.equal(
    await malformed.cancelOrder(7, 'server-old'),
    false,
    '确认响应丢 externalId 时仍必须用 server orderId 识别尚存订单',
  );
  assert.equal(malformed._tracked.has('server-old'), true);

  const unidentified = new ExtendedExchange({
    apiKey: 'test', vault: '1', privateKey: '1', cancelConfirmDelayMs: 0, cancelConfirmAttempts: 2,
  });
  unidentified.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  unidentified._tracked.set('server-old', { marketId: 7, externalId: 'exact-old' });
  unidentified._req = async (method) => method === 'GET'
    ? [{ market: 'BTC-USD', type: 'LIMIT', status: 'NEW', side: 'BUY', price: '62000', qty: '1', filledQty: '0', reduceOnly: false }]
    : null;
  assert.equal(
    await unidentified.cancelOrder(7, 'server-old'),
    false,
    '同时缺失 server/external id 的畸形挂单不能作为目标已消失的证据',
  );
  assert.equal(unidentified._tracked.has('server-old'), true);
  console.log('  ✓ Extended async cancellation waits for authoritative open-book confirmation');
}

{
  const exchange = new RisexExchange({ account: '0xtest', signerKey: 'test' });
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD', stepPrice: 0.5, stepSize: 0.001 });
  exchange._info = { getOpenOrders: async () => [{
    order_id: 'rs-encoded', side: 0, order_type: 1, price_ticks: 123456,
    size_steps: 789, reduce_only: true,
  }] };

  assert.deepEqual(await exchange.fetchOpenOrders(7), [{
    orderId: 'rs-encoded', price: 61728, side: 'buy', sizeBase: null,
    reduceOnly: true, metadataComplete: false,
  }]);
  console.log('  ✓ RISEx open orders keep undocumented remaining quantity fail-closed');
}

{
  const exchange = new RisexExchange({ account: '0xtest', signerKey: 'test' });
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD', stepPrice: 0.5, stepSize: 0.01 });
  exchange._client = { placeOrder: async () => ({ order_id: 'rs-quantized' }) };

  const result = await exchange.placeLimitOrder({
    marketId: 7, levelIndex: 2, side: 'buy', price: 12.26, sizeBase: 0.027,
    reduceOnly: false,
  });
  assert.deepEqual(result, { orderId: 'rs-quantized', priceUsed: 12.5, sizeUsed: 0.03 });
  assert.equal(exchange._tracked.get('rs-quantized').price, 12.5);
  assert.equal(exchange._tracked.get('rs-quantized').sizeBase, 0.03);
  console.log('  ✓ RISEx tracks the same quantized price and size it reports to GridBot');
}

{
  const exchange = new RisexExchange({ account: '0xtest', signerKey: 'test' });
  exchange._client = {
    cancelOrder: async () => ({ success: false, tx_hash: '0xfail' }),
    cancelAllOrders: async () => ({ success: false, tx_hash: '0xfail' }),
  };
  exchange._tracked.set('order-1', { marketId: 7 });
  exchange._tracked.set('order-2', { marketId: 7 });

  assert.equal(await exchange.cancelOrder(7, 'order-1'), false);
  assert.equal(exchange._tracked.has('order-1'), true, 'RISEx 单笔撤单 success=false 时必须保留跟踪');
  assert.equal(await exchange.cancelAll(7), false);
  assert.equal(exchange._tracked.has('order-1'), true);
  assert.equal(exchange._tracked.has('order-2'), true, 'RISEx 批量撤单 success=false 时必须保留全部跟踪');
  exchange._client.cancelOrder = async () => null;
  exchange._client.cancelAllOrders = async () => null;
  assert.equal(await exchange.cancelOrder(7, 'order-1'), false, 'RISEx 空响应不能当作撤单成功');
  assert.equal(await exchange.cancelAll(7), false, 'RISEx 空批量响应不能清空本地跟踪');
  console.log('  ✓ RISEx cancellation honors the SDK success flag');
}

{
  const exchange = new ExtendedExchange({ apiKey: 'test', vault: '1', privateKey: '1' });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  exchange.adoptOrder({
    orderId: 'rounded-server-id', externalId: '123456789012345678901234567890', marketId: 7,
    levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001,
  });
  exchange._get = async () => [{
    id: 12345678901234568000,
    externalId: '123456789012345678901234567890',
    status: 'FILLED', filledQty: '0.001', averagePrice: '62000',
  }];
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  await exchange._resolveGone('rounded-server-id', exchange._tracked.get('rounded-server-id'));

  assert.equal(fills.length, 1, 'Extended 重启后必须用精确 externalId 确认停机期间成交');
  assert.equal(exchange._tracked.has('rounded-server-id'), false);
  console.log('  ✓ Extended external order IDs survive restart for downtime-fill confirmation');
}

{
  const exchange = new ExtendedExchange({ apiKey: 'test', vault: '1', privateKey: '1' });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD' });
  exchange.adoptOrder({
    orderId: 'outside-first-page', externalId: 'exact-outside-first-page', marketId: 7,
    levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001,
  });
  exchange._tracked.get('outside-first-page').goneAttempts = 11;
  exchange._get = async () => Array.from({ length: 200 }, (_, index) => ({
    id: `history-${index}`, externalId: `exact-history-${index}`, status: 'CANCELLED',
  }));

  await exchange._resolveGone('outside-first-page', exchange._tracked.get('outside-first-page'));

  assert.equal(
    exchange._tracked.has('outside-first-page'),
    true,
    'Extended 历史首屏满载且未命中时必须保留跟踪',
  );
  console.log('  ✓ Extended full history pages fail closed instead of dropping tracking');
}

{
  const exchange = new ExtendedExchange({ apiKey: 'test', vault: '1', privateKey: '1' });
  exchange.markets.set(7, { marketId: 7, name: 'BTC-USD', displayName: 'BTC-USD' });
  exchange.fetchOpenOrders = async () => [{
    orderId: 'legacy-rounded-id', externalId: '123456789012345678901234567890',
    price: 62000, side: 'buy', sizeBase: 0.001, reduceOnly: false,
    metadataComplete: true,
  }];
  exchange.getPrice = async () => 65000;
  exchange.start = () => {};
  const bot = new GridBot(exchange);
  await bot.resume({
    ...runningGrid,
    active: [['legacy-rounded-id', { ...runningGrid.active[0][1] }]],
  });

  assert.equal(bot.active.get('legacy-rounded-id').externalId, '123456789012345678901234567890');
  assert.equal(exchange._tracked.get('legacy-rounded-id').externalId, '123456789012345678901234567890');
  bot._stopReconcileTimer();

  const missing = new ExtendedExchange({ apiKey: 'test', vault: '1', privateKey: '1' });
  missing.markets.set(7, { marketId: 7, name: 'BTC-USD', displayName: 'BTC-USD' });
  missing.fetchOpenOrders = async () => [];
  missing.getPrice = async () => 65000;
  missing.start = () => {};
  await assert.rejects(
    () => new GridBot(missing).resume({
      ...runningGrid,
      active: [['legacy-rounded-id', { ...runningGrid.active[0][1] }]],
    }),
    (error) => error.code === 'UNSAFE_RESUME' && /无法确认旧订单身份/.test(error.message),
    '旧版 Extended 订单已离开盘口且缺少稳定 externalId 时必须拒绝猜测式接管',
  );
  console.log('  ✓ legacy Extended orders enrich a stable identity or fail closed');
}

{
  const exchange = new RisexExchange({ account: '0xtest', signerKey: 'test', pollMs: 1 });
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD', stepPrice: 1 });
  exchange._watch.add(7);
  exchange._info = {
    getOrderbook: async () => ({ bids: [[119]], asks: [[121]] }),
    getOpenOrders: async () => [],
    getAccountTradeHistory: async () => [{
      order_id: 'order-downtime', market_id: '7', side: 0, size: '1', price: '100', timestamp: '1',
    }],
    getOrderHistory: async () => [],
    getPosition: async () => ({ size: '1', side: 0, avg_entry_price: '100', mark_price: '120' }),
    getBalance: async () => '10000',
    getRealizedPnl: async () => null,
  };
  exchange.adoptOrder({ orderId: 'order-downtime', marketId: 7, levelIndex: 0, side: 'buy', price: 100, sizeBase: 1 });
  exchange._tracked.get('order-downtime').placedAt = 0;
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  await exchange._poll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fills.length, 1, 'RISEx 重启后必须使用账户成交历史确认停机期间成交');
  assert.equal(fills[0].price, 100);
  assert.equal(exchange._tracked.has('order-downtime'), false);
  console.log('  ✓ RISEx account history confirms fills that happened while offline');
}

{
  const exchange = new RisexExchange({ account: '0xtest', signerKey: 'test' });
  exchange._info = {
    getAccountTradeHistory: async () => Array.from({ length: 200 }, (_, index) => ({
      order_id: `trade-${index}`, size: '0', price: '0',
    })),
    getOrderHistory: async () => Array.from({ length: 200 }, (_, index) => ({
      order_id: `history-${index}`, status: 'CANCELLED',
    })),
  };
  exchange.adoptOrder({
    orderId: 'outside-first-page', marketId: 7, levelIndex: 1,
    side: 'sell', price: 100, sizeBase: 1,
  });
  exchange._tracked.get('outside-first-page').goneAttempts = 11;

  await exchange._resolveGone('outside-first-page', exchange._tracked.get('outside-first-page'));

  assert.equal(
    exchange._tracked.has('outside-first-page'),
    true,
    'RISEx 成交/订单历史首屏满载且未命中时必须保留跟踪',
  );
  console.log('  ✓ RISEx full history pages fail closed instead of dropping tracking');
}

{
  const events = [];
  const critical = [];
  const exchange = new ResumeExchange();
  exchange.cancelAll = async () => { events.push('cancel-exchange'); return true; };
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => {
      const copy = JSON.parse(JSON.stringify(snapshot));
      critical.push(copy);
      events.push(copy.pendingAction ? 'persist-intent' : 'persist-final');
      return true;
    },
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.active.set('order-1', { ...runningGrid.active[0][1] });
  await bot.cancelAllOrders();

  assert.deepEqual(events, ['persist-intent', 'cancel-exchange', 'persist-final']);
  assert.equal(critical[0].pendingAction.type, 'cancel-orders');
  assert.equal(critical[0].running, false);
  assert.equal(critical[1].pendingAction, undefined);
  assert.equal(critical[1].active.length, 0);

  const afterCrash = new GridBot(new ResumeExchange(), { onCriticalChange: () => true });
  afterCrash.restore(critical[0]);
  await assert.rejects(
    () => afterCrash.start(runningGrid.config),
    /交易操作已锁定.*未完成的 cancel-orders 操作/,
  );
  console.log('  ✓ cancel intent is durable before exchange mutation and blocks ambiguous crash recovery');
}

{
  const exchange = new ResumeExchange();
  exchange.cancelAll = async () => false;
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.active.set('order-1', { ...runningGrid.active[0][1] });

  await assert.rejects(() => bot.cancelAllOrders(), /撤销全部挂单未被交易所确认成功/);
  assert.equal(bot.pendingAction?.type, 'cancel-orders', '撤单返回 false 时必须保留未完成意图');
  assert.equal(bot.active.has('order-1'), true, '撤单未确认时不得遗忘本地跟踪订单');
  assert.match(bot.tradingBlock, /撤单失败/);
  console.log('  ✓ resolved-false cancellation remains pending and blocks trading');
}

{
  let releasePrice;
  let priceRequested;
  const priceStarted = new Promise((resolve) => { priceRequested = resolve; });
  const exchange = new ResumeExchange();
  exchange.getPrice = () => { priceRequested(); return new Promise((resolve) => { releasePrice = resolve; }); };
  exchange.setLeverage = async () => true;
  exchange.cancelAll = async () => true;
  exchange.placeLimitOrder = async ({ clientOrderId }) => ({ orderId: `order-${clientOrderId}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  const starting = bot.start(runningGrid.config);
  await priceStarted;
  await assert.rejects(() => bot.cancelAllOrders(), /已有 start 操作正在执行/);
  releasePrice(65000);
  await starting;
  assert.equal(bot.running, true);
  bot._stopReconcileTimer();
  console.log('  ✓ mutation lease prevents cancel/start interleaving during preflight');
}

for (const scenario of [
  { mode: 'long', position: 5, exitSide: 'sell' },
  { mode: 'short', position: -5, exitSide: 'buy' },
  { mode: 'neutral', position: 5, exitSide: 'sell' },
  { mode: 'neutral', position: -5, exitSide: 'buy' },
]) {
  const exchange = new ResumeExchange();
  const placements = [];
  let refreshCalls = 0;
  exchange.getPrice = async () => 100;
  exchange.getPosition = () => ({ sizeBase: scenario.position, entryPrice: 100, unrealizedPnl: 0 });
  exchange.refreshPosition = async () => { refreshCalls += 1; return exchange.getPosition(); };
  exchange.setLeverage = async () => true;
  exchange.cancelAll = async () => true;
  exchange.placeLimitOrder = async (order) => {
    placements.push(order);
    return { orderId: `start-${placements.length}` };
  };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await bot.start({
    marketId: 7, mode: scenario.mode, lower: 60, upper: 140,
    gridCount: 4, sizeBase: 1, leverage: 3,
  });

  const exits = placements.filter((order) => order.side === scenario.exitSide && order.reduceOnly);
  assert.ok(refreshCalls >= 2, `${scenario.mode} 启动前后必须权威刷新保留仓位`);
  assert.equal(
    exits.reduce((sum, order) => sum + order.sizeBase, 0),
    Math.abs(scenario.position),
    `${scenario.mode} 重新启动后必须先用 reduce-only 订单覆盖全部保留仓位`,
  );
  bot._stopReconcileTimer();
}
console.log('  ✓ restart rebuilds complete exits for retained long, short, and neutral inventory');

{
  let rejectPlacement;
  const exchange = new ResumeExchange();
  let placeCalls = 0;
  exchange.placeLimitOrder = () => {
    placeCalls += 1;
    return new Promise((_resolve, reject) => { rejectPlacement = reject; });
  };
  const critical = [];
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => { critical.push(JSON.parse(JSON.stringify(snapshot))); return true; },
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };

  const placing = bot._place({ levelIndex: 3, side: 'sell', price: 63000, sizeBase: 0.001, opening: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(placeCalls, 1);
  assert.equal(critical[0].pendingOrders.length, 1, '请求到达交易所前必须先同步落盘下单意图');
  const afterCrash = new GridBot(new ResumeExchange());
  afterCrash.restore(critical[0]);
  assert.match(afterCrash.tradingBlock, /结果尚未确认的下单请求/);
  rejectPlacement(new Error('injected lost response'));
  await assert.rejects(() => placing, /injected lost response/);
  console.log('  ✓ in-flight order intent survives an accepted-but-unanswered crash window');
}

{
  const exchange = new ResumeExchange();
  let placeCalls = 0;
  exchange.placeLimitOrder = async () => { placeCalls += 1; return { orderId: 'unexpected' }; };
  const bot = new GridBot(exchange, { onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.blockTrading('市场映射失败');
  await assert.rejects(
    () => bot._place({ levelIndex: 3, side: 'sell', price: 63000, sizeBase: 0.001, opening: false }),
    /交易操作已锁定/,
  );
  assert.equal(placeCalls, 0, '交易锁必须同时阻断后台补单');
  console.log('  ✓ trading block stops background placements');
}

{
  let persistenceOk = false;
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange, {
    onChange: () => {}, onCriticalChange: () => true, canTrade: () => persistenceOk,
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000], spacing: 1000, count: 2 };

  assert.equal(bot._backgroundTradingAllowed(), false);
  assert.equal(bot.tradingBlock, '状态持久化异常，无法保证重启后接管订单');
  persistenceOk = true;
  assert.equal(bot.clearRecoveredPersistenceBlock(), true);
  assert.equal(bot.tradingBlock, null);
  assert.equal(bot._backgroundTradingAllowed(), true);
  console.log('  ✓ a recovered persistent volume can clear only its exact transient block');
}

{
  let persistenceOk = false;
  let fetches = 0;
  let placements = 0;
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => { fetches += 1; throw new Error('injected open-order outage after volume recovery'); };
  exchange.placeLimitOrder = async () => ({ orderId: `blind-${++placements}` });
  const bot = new GridBot(exchange, {
    onChange: () => {}, onCriticalChange: () => true, canTrade: () => persistenceOk,
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000, 63000], spacing: 1000, count: 3 };
  bot._deferredPlacements.set('replacement-1', {
    levelIndex: 3, side: 'sell', price: 63000, sizeBase: 0.001, opening: false,
  });
  assert.equal(bot._backgroundTradingAllowed(), false);
  persistenceOk = true;

  await assert.rejects(() => bot.recoverPersistenceAndReconcile(), /open-order outage/);
  assert.equal(fetches, 1);
  assert.equal(placements, 0, '持久卷恢复后仍无法对账时不得盲目补挂');
  assert.equal(bot._deferredPlacements.size, 1);
  assert.match(bot.tradingBlock, /状态持久化异常/);
  console.log('  ✓ persistence recovery strictly reconciles before draining deferred orders');
}

{
  let releaseFetch;
  let fetchRequested;
  const fetchStarted = new Promise((resolve) => { fetchRequested = resolve; });
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = () => {
    fetchRequested();
    return new Promise((resolve) => { releaseFetch = resolve; });
  };
  let placements = 0;
  exchange.placeLimitOrder = async () => ({ orderId: `replacement-${++placements}` });
  const critical = [];
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => { critical.push(JSON.parse(JSON.stringify(snapshot))); return true; },
  });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000, 63000, 64000], spacing: 1000, count: 4 };
  bot.active.set('order-1', { levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001, opening: true });

  const reconciling = bot.reconcileOpenOrders();
  await fetchStarted;
  bot._handleFill({ orderId: 'order-1', marketId: 7, side: 'buy', price: 61000, sizeBase: 0.001, levelIndex: 1 });
  assert.equal(critical.at(-1).deferredPlacements.length, 1, '对账占用互斥锁时成交补挂必须先进入快照');
  releaseFetch([]);
  await reconciling;

  assert.equal(placements, 1, '对账结束后必须补上成交对应的退出单');
  assert.equal(bot._deferredPlacements.size, 0);
  assert.ok([...bot.active.values()].some((order) => order.side === 'sell'));

  const persistedDuringLease = critical.find((snapshot) => snapshot.deferredPlacements?.length);
  const restartedExchange = new ResumeExchange();
  restartedExchange.placeLimitOrder = async () => ({ orderId: 'replacement-after-restart' });
  const restarted = new GridBot(restartedExchange, { onChange: () => {}, onCriticalChange: () => true });
  await restarted.resume(persistedDuringLease);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...restarted.active.values()].some((order) => order.side === 'sell'), '重启后也必须续做已落盘的补挂腿');
  restarted._stopReconcileTimer();
  console.log('  ✓ fills during reconciliation persist and drain their replacement leg');
}

{
  let releaseFetch;
  let fetchRequested;
  const fetchStarted = new Promise((resolve) => { fetchRequested = resolve; });
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = () => {
    fetchRequested();
    return new Promise((resolve) => { releaseFetch = resolve; });
  };
  exchange.placeLimitOrder = async () => ({ orderId: 'replacement-1' });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000], spacing: 1000, count: 2 };
  bot.active.set('order-1', { levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001, opening: true });

  const reconciling = bot.reconcileOpenOrders();
  await fetchStarted;
  bot._handleFill({ orderId: 'order-1', marketId: 7, side: 'buy', price: 61000, sizeBase: 0.001, levelIndex: 1 });
  releaseFetch([{ orderId: 'order-1', price: 61000, side: 'buy' }]);
  await reconciling;

  assert.equal(exchange.adopted.filter((order) => order.orderId === 'order-1').length, 0, '对账的过期响应不得复活请求期间已成交的订单');
  assert.equal(bot.active.has('order-1'), false);
  assert.equal(bot.active.has('replacement-1'), true);
  console.log('  ✓ stale reconciliation cannot resurrect an order filled during the request');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.fetchOpenOrders = async () => { throw new Error('injected resume reconciliation outage'); };
  exchange.placeLimitOrder = async () => { placements += 1; return { orderId: `duplicate-${placements}` }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  const snapshot = {
    ...runningGrid,
    active: [],
    deferredPlacements: [['replacement-1', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001, opening: false,
    }]],
  };

  await assert.rejects(
    () => bot.resume(snapshot),
    (error) => error.code === 'UNSAFE_RESUME' && /无法核对真实挂单/.test(error.message),
  );
  assert.equal(placements, 0, '恢复对账失败时不得盲目提交已持久化的补挂单');
  assert.equal(bot._deferredPlacements.size, 1, '未提交的补挂意图必须保留供人工核对');
  assert.match(bot.tradingBlock, /无法核对真实挂单/);
  bot._stopReconcileTimer();
  console.log('  ✓ persisted replacement waits for a successful resume reconciliation');
}

{
  const exchange = new ResumeExchange();
  let fetches = 0;
  let placements = 0;
  exchange.fetchOpenOrders = async () => {
    fetches += 1;
    if (fetches === 1) throw new Error('injected first resume outage');
    return [];
  };
  exchange.placeLimitOrder = async () => ({ orderId: `replacement-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  const snapshot = {
    ...runningGrid,
    active: [],
    deferredPlacements: [['replacement-1', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001, opening: false,
    }]],
  };

  await assert.rejects(() => bot.resume(snapshot), /injected first resume outage/);
  await bot.retryResumeReconciliation();

  assert.equal(fetches, 2, '重连必须真正重试读取交易所挂单');
  assert.equal(placements, 1, '可信对账成功后才可提交已持久化的补挂腿');
  assert.equal(bot._deferredPlacements.size, 0);
  assert.equal(bot.tradingBlock, null);
  bot._stopReconcileTimer();
  console.log('  ✓ reconnect retries a transiently failed resume reconciliation');
}

{
  const exchange = new ResumeExchange();
  const events = [];
  let placements = 0;
  exchange.getPrice = async (_marketId, opts = {}) => {
    assert.equal(opts.requireFresh, true);
    events.push('fresh-price');
    return 50000;
  };
  exchange.fetchOpenOrders = async () => { events.push('open-orders'); return []; };
  exchange.placeLimitOrder = async () => { placements += 1; return { orderId: 'must-not-place' }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  const snapshot = {
    ...runningGrid,
    active: [],
    deferredPlacements: [['outside-opening', {
      levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true,
    }]],
  };

  await assert.rejects(
    () => bot.resume(snapshot),
    (error) => error.code === 'UNSAFE_RESUME' && /当前价 50000 已在网格区间外/.test(error.message),
  );
  assert.deepEqual(events, ['fresh-price'], '越界时必须在读真实挂单和补挂前中止');
  assert.equal(placements, 0, '停机期间已经越界时不得提交快照中的 opening 补挂腿');
  assert.equal(bot.lastPrice, 50000);
  assert.equal(bot.outOfRange, true);
  assert.equal(bot._deferredPlacements.size, 1, '越界拒绝续跑时必须保留未提交意图');
  assert.match(bot.tradingBlock, /当前价.*网格区间外/);
  console.log('  ✓ resume checks a fresh price before draining deferred opening orders');
}

{
  const exchange = new ResumeExchange();
  let fetches = 0;
  exchange.getPrice = async () => { throw new Error('injected live-price outage'); };
  exchange.fetchOpenOrders = async () => { fetches += 1; return []; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(
    () => bot.resume({ ...runningGrid, active: [] }),
    (error) => error.code === 'UNSAFE_RESUME' && /无法取得实时价格/.test(error.message),
  );
  assert.equal(fetches, 0, '实时价格不可用时不得进入真实挂单对账或自动交易');
  assert.match(bot.tradingBlock, /无法取得实时价格/);
  console.log('  ✓ resume fails closed when no authoritative current price is available');
}

{
  const exchange = new ResumeExchange();
  const events = [];
  let placements = 0;
  exchange.getPrice = async () => { events.push('fresh-price'); return 65000; };
  exchange.fetchOpenOrders = async () => { events.push('open-orders'); return []; };
  exchange.placeLimitOrder = async () => {
    events.push('place'); placements += 1;
    return { orderId: `replacement-${placements}` };
  };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  await bot.resume({
    ...runningGrid,
    active: [],
    deferredPlacements: [['inside-closing', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001, opening: false,
    }]],
  });

  assert.deepEqual(
    events.slice(0, 4),
    ['fresh-price', 'open-orders', 'fresh-price', 'place'],
    '对账等待期可收到新行情，补挂前必须再做一次实时价核验',
  );
  assert.equal(placements, 1, '区间内恢复时持久化补挂腿只能提交一次');
  assert.equal(bot.lastPrice, 65000);
  assert.equal(bot._deferredPlacements.size, 0);
  bot._stopReconcileTimer();
  console.log('  ✓ in-range resume orders fresh price, strict reconciliation, then one drain');
}

{
  const exchange = new ResumeExchange();
  let prices = 0, fetches = 0;
  exchange.getPrice = async () => (prices++ === 0 ? 0 : 65000);
  exchange.fetchOpenOrders = async () => { fetches += 1; return []; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(() => bot.resume({ ...runningGrid, active: [] }), /无法取得实时价格/);
  await bot.retryResumeReconciliation();

  assert.equal(prices, 3, '重连恢复必须在对账前后都重新读取权威现价');
  assert.equal(fetches, 1, '即使没有 deferred，重连也必须重试严格挂单对账');
  assert.equal(bot.tradingBlock, null);
  bot._stopReconcileTimer();
  console.log('  ✓ reconnect retries fresh price and strict reconciliation without deferred orders');
}

{
  const exchange = new ResumeExchange();
  const snapshots = [];
  const snapshot = {
    ...runningGrid,
    outOfRange: true,
    config: { ...runningGrid.config, outOfRangeAction: 'recover' },
    active: [['recovery-1', {
      levelIndex: -1, side: 'sell', price: 59000, sizeBase: 0.001,
      opening: false, reduceOnly: true, recovery: true,
    }]],
  };
  exchange.fetchOpenOrders = async () => [{
    orderId: 'recovery-1', price: 59000, side: 'sell', sizeBase: 0.001,
    reduceOnly: true, metadataComplete: true,
  }];
  exchange.getPrice = async () => 65000;
  const bot = new GridBot(exchange, {
    onChange: (state) => snapshots.push(JSON.parse(JSON.stringify(state))),
    onCriticalChange: () => true,
  });

  await assert.rejects(() => bot.resume(snapshot), /停机前网格已处于区间外/);
  await assert.rejects(() => bot.retryResumeReconciliation(), /停机前网格已处于区间外/);
  assert.equal(
    snapshots.at(-1)?.resumeReviewRequired,
    true,
    '人工核对标记必须跨进程持久化，不得靠内存标志',
  );

  const restartedExchange = new ResumeExchange();
  restartedExchange.getPrice = async () => 65000;
  restartedExchange.fetchOpenOrders = exchange.fetchOpenOrders;
  const restarted = new GridBot(restartedExchange, { onChange: () => {}, onCriticalChange: () => true });
  await assert.rejects(
    () => restarted.resume(snapshots.at(-1)),
    /停机前网格已处于区间外/,
  );
  assert.equal(restarted.active.has('recovery-1'), true, '再次重启不得静默丢弃或越过原回收单');
  console.log('  ✓ an out-of-range recovery review remains fail-closed across retry and restart');
}

{
  const exchange = new ResumeExchange();
  let reads = 0, placements = 0;
  exchange.getPrice = async () => (++reads === 1 ? 50000 : 65000);
  exchange.fetchOpenOrders = async () => [];
  exchange.placeLimitOrder = async () => ({ orderId: `must-not-place-${++placements}` });
  const snapshots = [];
  const bot = new GridBot(exchange, {
    onChange: (state) => snapshots.push(JSON.parse(JSON.stringify(state))),
    onCriticalChange: () => true,
  });
  const snapshot = {
    ...runningGrid,
    active: [],
    deferredPlacements: [['outside-opening', {
      levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true,
    }]],
  };

  await assert.rejects(() => bot.resume(snapshot), /当前价 50000 已在网格区间外/);
  await assert.rejects(
    () => bot.retryResumeReconciliation(),
    /网格已处于区间外|人工核对/,
  );
  assert.equal(placements, 0, '首次恢复发现越界后，即使价格回区间也不得自动提交 opening');
  assert.equal(bot._resumeReviewRequired, true);
  assert.equal(snapshots.at(-1)?.resumeReviewRequired, true, '首次发现越界也必须落盘人工核对标记');
  console.log('  ✓ a newly discovered out-of-range resume remains locked after price returns');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.getPrice = async () => {
    exchange.emit('fill', {
      orderId: 'old-close', marketId: 7, side: 'sell', price: 64000,
      sizeBase: 0.001, levelIndex: 4,
    });
    return 50000;
  };
  exchange.placeLimitOrder = async () => ({ orderId: `must-not-place-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  const snapshot = {
    ...runningGrid,
    active: [['old-close', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001,
      opening: false, reduceOnly: false,
    }]],
  };

  await assert.rejects(() => bot.resume(snapshot), /当前价 50000 已在网格区间外/);
  assert.equal(placements, 0, '恢复安全闸未完成时，成交事件不得触发 opening 补单');
  assert.equal(bot._deferredPlacements.size, 1, '核验期成交的补挂意图必须留待安全对账');
  console.log('  ✓ resume gate prevents fill callbacks from placing before safety checks finish');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.start = () => {
    exchange.emit('fill', {
      orderId: 'start-window-fill', marketId: 7, side: 'sell', price: 64000,
      sizeBase: 0.001, levelIndex: 4,
    });
  };
  exchange.getPrice = async () => 50000;
  exchange.placeLimitOrder = async () => ({ orderId: `must-not-place-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(() => bot.resume({
    ...runningGrid,
    active: [['start-window-fill', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001,
      opening: false, reduceOnly: false,
    }]],
  }), /当前价 50000 已在网格区间外/);
  assert.equal(placements, 0, '适配器 start 同步发出成交时也必须已经处于恢复闸内');
  assert.equal(bot._deferredPlacements.size, 1);
  console.log('  ✓ resume gate is active before exchange listeners can emit fills');
}

{
  const exchange = new ResumeExchange();
  let priceReads = 0, placements = 0;
  exchange.getPrice = async () => (++priceReads <= 2 ? 65000 : 50000);
  exchange.fetchOpenOrders = async () => [];
  exchange.placeLimitOrder = async (order) => {
    placements += 1;
    if (placements === 1) exchange.emit('price', { marketId: 7, price: 50000 });
    return { orderId: `placed-${order.levelIndex}` };
  };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(() => bot.resume({
    ...runningGrid,
    active: [],
    deferredPlacements: [
      ['first', { levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true }],
      ['second', { levelIndex: 3, side: 'buy', price: 63000, sizeBase: 0.001, opening: true }],
    ],
  }), /补挂期间行情已变化/);
  assert.equal(placements, 1, '第一笔等待回执时已越界，不得继续提交第二笔 opening');
  assert.equal(bot.outOfRange, true);
  assert.equal(bot._deferredPlacements.size, 1, '未提交的后续意图必须保留');
  assert.match(bot.tradingBlock, /停机前网格已处于区间外|补挂期间行情已变化/);
  console.log('  ✓ resume drain aborts before the next order when price crosses the range');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.getPrice = async () => 65000;
  exchange.fetchOpenOrders = async () => [];
  exchange.placeLimitOrder = async () => ({ orderId: `must-not-place-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  const reconnect = bot._withMutation('reconnect', async () => {
    await bot.resume({
      ...runningGrid,
      active: [],
      deferredPlacements: [['reconnect-opening', {
        levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true,
      }]],
    });
    exchange.emit('price', { marketId: 7, price: 50000 });
  }, { allowBlocked: true });
  await assert.rejects(reconnect, /网格已处于区间外|补挂期间行情已变化/);

  assert.equal(placements, 0, '重连外层 mutation 不得绕过 resume-aware drain 在越界后补 opening');
  assert.equal(bot.outOfRange, true);
  assert.equal(bot._deferredPlacements.size, 1);
  assert.match(bot.tradingBlock, /停机前网格已处于区间外|补挂期间行情已变化/);
  console.log('  ✓ reconnect mutation cannot defer resume drain past its safety gate');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.getPrice = async () => 65000;
  exchange.fetchOpenOrders = async () => [];
  exchange.placeLimitOrder = async () => ({ orderId: `reconnect-safe-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.blockTrading('交易所离线，运行中网格尚未接管；挂单和仓位必须先核对');

  await bot._withMutation('reconnect', () => bot.resume({
    ...runningGrid,
    active: [],
    deferredPlacements: [['reconnect-closing', {
      levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001, opening: false,
    }]],
  }), { allowBlocked: true });

  assert.equal(placements, 1, '区间内重连应在恢复闸内只提交一次持久化补挂');
  assert.equal(bot._deferredPlacements.size, 0);
  assert.equal(bot.tradingBlock, null, '安全接管完成后不得恢复旧的离线锁');
  assert.equal(bot.getOperationalBlock(), null);
  bot._stopReconcileTimer();
  console.log('  ✓ successful reconnect clears its old offline block after gated drain');
}

{
  const exchange = new ResumeExchange();
  let reads = 0, placements = 0;
  exchange.fetchOpenOrders = async () => {
    reads += 1;
    return [];
  };
  exchange.placeLimitOrder = async () => ({ orderId: `duplicate-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      active: [['tracked-one', {
        levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true,
      }]],
      deferredPlacements: [['pending-close', {
        levelIndex: 4, side: 'sell', price: 64000, sizeBase: 0.001, opening: false,
      }]],
    }),
    /本地订单 tracked-one 未出现在真实挂单列表|\u4ea4易所返回 0 单.*本地仍跟踪 1 单/,
  );
  assert.equal(reads, 1);
  assert.equal(placements, 0, '单次 false-empty 不得触发持久化补挂意图');
  console.log('  ✓ strict resume rejects a false-empty snapshot even with one tracked order');
}

{
  const exchange = new ResumeExchange();
  let placements = 0;
  exchange.fetchOpenOrders = async () => [{
    orderId: 'survivor', price: 62000, side: 'buy', sizeBase: 0.001,
    reduceOnly: false, metadataComplete: true,
  }];
  exchange.placeLimitOrder = async () => ({ orderId: `must-not-place-${++placements}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      active: [
        ['survivor', { levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true, reduceOnly: false }],
        ['filled-offline', { levelIndex: 3, side: 'buy', price: 63000, sizeBase: 0.001, opening: true, reduceOnly: false }],
      ],
      deferredPlacements: [['pending-opening', {
        levelIndex: 4, side: 'buy', price: 64000, sizeBase: 0.001, opening: true,
      }]],
    }),
    /本地订单 filled-offline 未出现在真实挂单列表/,
  );
  assert.equal(placements, 0, '停机期间消失的订单未查明前不得继续 opening 补挂');
  assert.match(bot.tradingBlock, /未出现在真实挂单列表/);
  console.log('  ✓ strict resume rejects a partially vanished tracked order set');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{
    orderId: 'partial-live', price: 62000, side: 'buy', sizeBase: 0.25,
    reduceOnly: false, metadataComplete: true,
  }];
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      active: [['partial-live', {
        levelIndex: 2, side: 'buy', price: 62000, sizeBase: 1,
        opening: true, reduceOnly: false,
      }]],
    }),
    /剩余量从 1 变为 0.25/,
  );
  assert.match(bot.tradingBlock, /停机期间可能已部分成交/);
  console.log('  ✓ strict resume rejects an offline partial fill instead of leaving inventory naked');
}

{
  const exchange = new ResumeExchange();
  const cancelled = [];
  exchange.fetchOpenOrders = async () => [
    { orderId: 'tracked', price: 62000, side: 'buy', sizeBase: 0.001, reduceOnly: false, metadataComplete: true },
    { orderId: 'duplicate', price: 62000, side: 'buy', sizeBase: 0.001, reduceOnly: false, metadataComplete: true },
  ];
  exchange.cancelOrder = async (_marketId, orderId) => { cancelled.push(String(orderId)); return true; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      active: [['tracked', {
        levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true, reduceOnly: false,
      }]],
    }),
    /恢复安全核验发现同档重复挂单/,
  );
  assert.deepEqual(cancelled, [], '恢复闸完成前只能核对，不得自动撤真实重复单');
  console.log('  ✓ resume gate never mutates the exchange while checking duplicate orders');
}

{
  const exchange = new ResumeExchange();
  let fetches = 0;
  exchange.fetchOpenOrders = async () => { fetches += 1; return []; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.blockTrading('交易所离线，运行中网格尚未接管；挂单和仓位必须先核对');

  await bot.resume({ ...runningGrid, active: [] });

  assert.equal(fetches, 1, '重连后必须能在恢复闸内执行只读对账');
  assert.equal(bot.tradingBlock, null);
  bot._stopReconcileTimer();
  console.log('  ✓ an offline-start trading block can be safely replaced by the resume gate');
}

{
  const exchange = new ResumeExchange();
  const cancelled = [];
  exchange.fetchOpenOrders = async () => [
    { orderId: 'orphan-first', price: 62000, side: 'buy' },
    { orderId: 'tracked-second', price: 62000, side: 'buy' },
  ];
  exchange.cancelOrder = async (_marketId, orderId) => { cancelled.push(String(orderId)); return true; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000, 63000], spacing: 1000, count: 3 };
  bot.active.set('tracked-second', {
    levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001, opening: true, placedAt: Date.now(),
  });

  await bot.reconcileOpenOrders();

  assert.deepEqual(cancelled, ['orphan-first'], '同档去重必须优先保留已跟踪订单，不受 API 返回顺序影响');
  assert.equal(bot.active.has('tracked-second'), true);
  assert.equal(exchange.adopted.some((order) => order.orderId === 'orphan-first'), false);
  console.log('  ✓ reconciliation keeps the tracked survivor regardless of API order');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{ orderId: 'unknown-same-level', price: 62000, side: 'buy' }];
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000, 63000], spacing: 1000, count: 3 };
  bot.active.set('missing-tracked', {
    levelIndex: 2, side: 'buy', price: 62000, sizeBase: 0.001,
    opening: true, placedAt: Date.now(),
  });

  await assert.rejects(
    () => bot.reconcileOpenOrders({ strict: true }),
    /本地订单 missing-tracked 未出现在真实挂单列表|无法证明属于当前策略的未跟踪挂单 unknown-same-level/,
  );
  assert.equal(bot.active.has('missing-tracked'), true, '未查明的本地订单不得被静默删除');
  console.log('  ✓ a missing local order cannot legitimize an unknown real order on the same level');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{ orderId: 'orphan-live', price: 62000, side: 'buy' }];
  const critical = [];
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => {
      critical.push(JSON.parse(JSON.stringify(snapshot)));
      return true;
    },
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000, 63000], spacing: 1000, count: 3 };

  await assert.rejects(
    () => bot.reconcileOpenOrders(),
    /无法证明属于当前策略的未跟踪挂单 orphan-live/,
  );

  assert.equal(exchange.adopted.some((order) => order.orderId === 'orphan-live'), false);
  assert.equal(
    critical.at(-1)?.pendingAction?.type,
    'verify-orphan-order',
    '未知实单的人工核对意图必须同步持久化',
  );
  assert.equal(
    critical.at(-1)?.active.some(([orderId]) => orderId === 'orphan-live'),
    false,
    '未核实的交易所订单不得伪装成已接管订单',
  );
  console.log('  ✓ unknown orphan order blocks trading instead of being guessed into the grid');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{ orderId: 'orphan-rejected', price: 62000, side: 'buy' }];
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.grid = { levels: [60000, 61000, 62000, 63000], spacing: 1000, count: 3 };

  await assert.rejects(() => bot.reconcileOpenOrders(), /无法证明属于当前策略的未跟踪挂单/);

  assert.equal(bot.active.has('orphan-rejected'), false, '未核实的实单不得伪装成本地已跟踪');
  assert.equal(bot.pendingAction?.type, 'verify-orphan-order', '未知实单必须保留耐久核对意图');
  assert.match(bot.tradingBlock, /无法证明属于当前策略/);
  console.log('  ✓ unresolved orphan remains blocked and durably unresolved');
}

{
  const exchange = new ResumeExchange();
  const placements = [];
  exchange.placeLimitOrder = async (order) => { placements.push(order); return { orderId: `placed-${order.levelIndex}` }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000, 63000, 64000, 65000], spacing: 1000, count: 5 };
  bot.active.set('occupied-2', { levelIndex: 2, side: 'buy', price: 62000, opening: true });
  bot._deferredPlacements.set('blocked', { levelIndex: 2, side: 'sell', price: 62000, sizeBase: 0.001, opening: false });
  bot._deferredPlacements.set('free', { levelIndex: 5, side: 'sell', price: 65000, sizeBase: 0.001, opening: false });

  await bot._drainDeferredPlacements();

  assert.deepEqual(placements.map((order) => order.levelIndex), [5]);
  assert.equal(bot._deferredPlacements.has('blocked'), true, '占用档位的补挂意图应保留稍后重试');
  assert.equal(bot._deferredPlacements.has('free'), false, '后续独立档位不得被队首占用阻塞');
  console.log('  ✓ occupied deferred level cannot head-of-line block later replacements');
}

{
  const exchange = new ResumeExchange();
  const placements = [];
  let releaseFirst;
  exchange.placeLimitOrder = (order) => {
    placements.push(order.levelIndex);
    if (placements.length === 1) {
      return new Promise((resolve) => { releaseFirst = () => resolve({ orderId: 'first' }); });
    }
    return Promise.resolve({ orderId: `later-${order.levelIndex}` });
  };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000, 63000, 64000, 65000], spacing: 1000, count: 5 };
  bot._deferredPlacements.set('first', { levelIndex: 1, side: 'sell', price: 61000, sizeBase: 0.001, opening: false });
  bot.active.set('filled-during-drain', { levelIndex: 3, side: 'buy', price: 63000, sizeBase: 0.001, opening: true });

  const draining = bot._drainDeferredPlacements();
  await new Promise((resolve) => setImmediate(resolve));
  bot._handleFill({ orderId: 'filled-during-drain', marketId: 7, side: 'buy', price: 63000, sizeBase: 0.001, levelIndex: 3 });
  releaseFirst();
  await draining;

  assert.deepEqual(placements, [1, 4], 'drain 等待外部回执时新增的补挂腿也必须在同一轮处理');
  assert.equal(bot._deferredPlacements.size, 0);
  console.log('  ✓ replacement queued during an active drain is not stranded');
}

{
  const exchange = new ResumeExchange();
  const placements = [];
  exchange.cancelAll = async () => true;
  exchange.placeLimitOrder = async (order) => { placements.push(order); return { orderId: `order-${placements.length}` }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.lastPrice = 250;
  bot.config = {
    marketId: 7, displayName: 'BTC-USD', mode: 'long', lower: 80, upper: 120,
    gridCount: 2, sizeBase: 0.001, leverage: 3,
  };
  bot.grid = { levels: [80, 100, 120], spacing: 20, count: 2 };
  bot._deferredPlacements.set('old-range', { levelIndex: 1, side: 'buy', price: 100, sizeBase: 0.001, opening: true });

  await bot.adjustRange({ lower: 200, upper: 300 });

  assert.equal(placements.some((order) => order.price === 100), false, '新区间不得提交旧网格遗留的补挂意图');
  assert.equal(bot._deferredPlacements.size, 0);
  bot._stopReconcileTimer();
  console.log('  ✓ range adjustment retires deferred orders from the old grid');
}

{
  let releaseCancel;
  let cancelStarted;
  const cancelling = new Promise((resolve) => { cancelStarted = resolve; });
  const exchange = new ResumeExchange();
  const placements = [];
  exchange.cancelAll = () => {
    cancelStarted();
    return new Promise((resolve) => { releaseCancel = () => resolve(true); });
  };
  let position = null;
  exchange.refreshPosition = async () => position;
  exchange.placeLimitOrder = async (order) => { placements.push(order); return { orderId: `placed-${placements.length}` }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.lastPrice = 105;
  bot.config = {
    marketId: 7, displayName: 'BTC-USD', mode: 'long', lower: 100, upper: 120,
    gridCount: 2, sizeBase: 0.001, leverage: 3,
  };
  bot.grid = { levels: [100, 110, 120], spacing: 10, count: 2 };
  bot.active.set('old-buy', {
    levelIndex: 0, side: 'buy', price: 100, sizeBase: 0.001, opening: true, placedAt: Date.now(),
  });

  const adjusting = bot.adjustRange({ lower: 90, upper: 190 });
  await cancelling;
  position = { sizeBase: 0.001, entryPrice: 100, unrealizedPnl: 0 };
  bot._handleFill({ orderId: 'old-buy', marketId: 7, side: 'buy', price: 100, sizeBase: 0.001, levelIndex: 0 });
  releaseCancel();
  await adjusting;

  assert.ok(placements.some((order) => order.side === 'sell' && order.price === 140 && order.reduceOnly), '撤单窗口内形成的仓位必须按新区间重建 reduce-only 退出腿');
  assert.equal(bot._deferredPlacements.size, 0, '旧网格补挂意图必须由权威仓位重建取代');
  bot._stopReconcileTimer();
  console.log('  ✓ fills during range cancellation use their original grid context');
}

for (const scenario of [
  { mode: 'long', position: 1, exitSide: 'sell', exitPrice: 110, currentPrice: 100 },
  { mode: 'short', position: -1, exitSide: 'buy', exitPrice: 90, currentPrice: 100 },
]) {
  const exchange = new ResumeExchange();
  const placements = [];
  exchange.cancelAll = async () => true;
  exchange.placeLimitOrder = async (order) => { placements.push(order); return { orderId: `placed-${placements.length}` }; };
  exchange.getPosition = () => ({ sizeBase: scenario.position, entryPrice: 100, unrealizedPnl: 0 });
  exchange.refreshPosition = async () => exchange.getPosition();
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.lastPrice = scenario.currentPrice;
  bot.config = {
    marketId: 7, displayName: 'BTC-USD', mode: scenario.mode, lower: 80, upper: 120,
    gridCount: 4, sizeBase: 1, leverage: 3,
  };
  bot.grid = { levels: [80, 90, 100, 110, 120], spacing: 10, count: 4 };
  bot.active.set('old-exit', {
    levelIndex: scenario.exitPrice === 110 ? 3 : 1, side: scenario.exitSide, price: scenario.exitPrice,
    sizeBase: 1, opening: false, reduceOnly: true, placedAt: Date.now(),
  });

  await bot.adjustRange({ lower: 60, upper: 140 });

  assert.ok(
    placements.some((order) => order.side === scenario.exitSide && order.reduceOnly && order.sizeBase === 1),
    `${scenario.mode} 调区间后必须重建持仓的 reduce-only 退出腿`,
  );
  bot._stopReconcileTimer();
}
console.log('  ✓ range adjustment preserves long and short position exit coverage');

{
  const exchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  exchange.dataSource = 'synthetic';
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  exchange.prices.set(7, 61000);
  const captured = [];
  const capture = (snapshot) => { captured.push(JSON.parse(JSON.stringify(snapshot))); return true; };
  const bot = new GridBot(exchange, { onChange: capture, onCriticalChange: capture });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000], spacing: 1000, count: 2 };
  bot.active.set('paper-1', { levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001, opening: true });
  exchange.orders.set('paper-1', { orderId: 'paper-1', marketId: 7, levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001 });
  exchange._seq = 2;
  exchange.on('fill', bot._onFill);

  bot.beginShutdown();
  exchange._matchFills(7, 62000, 61000);
  const shutdownSnapshot = captured.at(-1);

  assert.equal(exchange.orders.has('paper-1'), false);
  assert.equal(shutdownSnapshot.active.some(([id]) => id === 'paper-1'), false, '关闭窗口内成交必须从最终 active 移除');
  assert.equal(shutdownSnapshot.deferredPlacements.length, 1, '关闭期间不得下新单，但补挂意图必须留到重启');
  const afterExchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  afterExchange.dataSource = 'synthetic';
  afterExchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  afterExchange.prices.set(7, 61000);
  const after = new GridBot(afterExchange, { onChange: () => {}, onCriticalChange: () => true });
  await after.resume(shutdownSnapshot);
  assert.equal(afterExchange.orders.has('paper-1'), false, '重启不得复活关闭窗口内已经成交的 paper 单');
  after._stopReconcileTimer();
  console.log('  ✓ shutdown keeps fill accounting without resurrecting filled paper orders');
}

{
  const exchange = new ResumeExchange();
  let cancels = 0;
  exchange.cancelAll = async () => { cancels += 1; return true; };
  exchange.closePosition = async () => true;
  exchange.refreshPosition = async () => null;
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config, outOfRangeAction: 'close' };
  bot.grid = { levels: [60000, 61000, 62000], spacing: 1000, count: 2 };
  bot.pendingOrders.set('unknown', { id: 'unknown' });

  bot._handlePrice({ marketId: 7, price: 71000 });
  assert.equal(bot.outOfRange, false, '有未确认下单时不得提前吞掉越界边沿');
  bot.pendingOrders.clear();
  bot._handlePrice({ marketId: 7, price: 71000 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(cancels, 1, '下单结果确认后下一行情必须重新触发越界处置');
  console.log('  ✓ pending order cannot swallow a later out-of-range stop');
}

{
  const bot = new GridBot(new ResumeExchange());
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.pendingAction = { type: 'stop', marketName: 'BTC-USD', at: Date.now() };
  assert.equal(bot.getState().health.status, 'error');
  assert.match(bot.getState().health.reason, /未完成的 stop 操作/);

  bot.pendingAction = null;
  bot.pendingOrders.set('unknown', { id: 'unknown' });
  assert.equal(bot.getState().health.status, 'error');
  assert.match(bot.getState().health.reason, /结果尚未确认的下单请求/);
  console.log('  ✓ unfinished exchange operations surface as unhealthy');
}

{
  const exchange = new ResumeExchange();
  exchange.cancelAll = async () => true;
  exchange.closePosition = async () => true;
  const bot = new GridBot(exchange, { onCriticalChange: () => true });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  await assert.rejects(() => bot.closePositionNow(8), /只能平当前已按名称确认的策略市场/);
  assert.equal(bot.running, true);
  console.log('  ✓ close-position cannot forget a different running market');
}

{
  const exchange = new ResumeExchange();
  exchange.closePosition = async () => false;
  exchange.refreshPosition = async () => null;
  const bot = new GridBot(exchange);
  assert.equal(await bot._closeWithConfirm(7), false, '平仓返回 false 时不得误报成功');
  console.log('  ✓ resolved-false close cannot be confirmed as success');
}

{
  const exchange = new ResumeExchange();
  let closes = 0;
  let refreshes = 0;
  exchange.refreshPosition = async () => {
    refreshes += 1;
    return refreshes < 3 ? { sizeBase: 0.1, entryPrice: 62000 } : null;
  };
  exchange.closePosition = async () => { closes += 1; return true; };
  const bot = new GridBot(exchange);
  assert.equal(await bot._closeWithConfirm(7), true);
  assert.ok(refreshes >= 4, '每次空仓确认都必须来自新的权威查询');
  assert.equal(closes, 1);
  console.log('  ✓ close confirmation uses fresh authoritative position reads');
}

{
  const events = [];
  const critical = [];
  const exchange = new ResumeExchange();
  exchange.cancelOrder = async (_marketId, orderId) => { events.push(`cancel-${orderId}`); };
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => {
      const copy = JSON.parse(JSON.stringify(snapshot));
      critical.push(copy);
      events.push(copy.pendingAction ? 'persist-intent' : 'persist-final');
      return true;
    },
  });
  bot.running = true;
  bot.config = { ...runningGrid.config };
  bot.active.set('recovery-1', {
    levelIndex: -1, side: 'sell', price: 59000, sizeBase: 0.001,
    opening: false, reduceOnly: true, recovery: true,
  });

  await bot._cancelRecoveryLadder();

  assert.deepEqual(events, ['persist-intent', 'cancel-recovery-1', 'persist-final']);
  assert.equal(critical[0].pendingAction.type, 'cancel-recovery-ladder');
  assert.equal(critical[1].active.length, 0);
  console.log('  ✓ recovery-ladder cancellation is durable before exchange mutation');
}

{
  const events = [];
  const critical = [];
  const exchange = new ResumeExchange();
  exchange.cancelAll = async () => { events.push('cancel-exchange'); };
  const bot = new GridBot(exchange, {
    onChange: () => {},
    onCriticalChange: (snapshot) => {
      const copy = JSON.parse(JSON.stringify(snapshot));
      critical.push(copy);
      events.push(copy.pendingAction ? 'persist-intent' : 'persist-final');
      return true;
    },
  });
  bot.running = true;
  bot.recovery = true;
  bot.config = { ...runningGrid.config, mode: 'recovery' };
  bot.active.set('recovery-1', {
    levelIndex: 1, side: 'sell', price: 63000, sizeBase: 0.001,
    opening: false, reduceOnly: true, recovery: true,
  });

  await bot._finishRecovery();

  assert.deepEqual(events, ['persist-intent', 'cancel-exchange', 'persist-final']);
  assert.equal(critical[0].pendingAction.type, 'finish-recovery');
  assert.equal(critical[0].running, false);
  assert.equal(critical[1].active.length, 0);
  console.log('  ✓ recovery completion is durable before exchange mutation');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await bot.resume(runningGrid);
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 1);
  assert.equal(exchange.adopted.length, 1);
  assert.deepEqual(bot.fills, runningGrid.fills);
  assert.ok(bot.alerts.some((a) => a.message === '网格运行中'));
  bot._stopReconcileTimer();
  console.log('  ✓ persisted running grid resumes orders and recent records');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await bot.resume({ ...runningGrid, exchangeMode: undefined });
  assert.equal(bot.running, true, '旧版实盘快照可由非 paper 订单 ID 安全识别并续跑');
  bot._stopReconcileTimer();
  console.log('  ✓ legacy live snapshots remain upgrade-compatible');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({ ...runningGrid, exchangeMode: 'paper' }),
    (error) => error.code === 'UNSAFE_RESUME' && /拒绝跨模式自动续跑/.test(error.message),
  );
  console.log('  ✓ paper/live mode changes cannot auto-resume incompatible orders');
}

{
  const exchange = new ResumeExchange();
  exchange.getMarkets = async () => [{ marketId: 7, displayName: 'ETH-USD' }];
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume(runningGrid),
    (error) => error.code === 'UNSAFE_RESUME' && /找不到原市场 BTC-USD.*拒绝使用旧 marketId/.test(error.message),
  );
  assert.equal(bot.running, false);
  assert.equal(exchange.adopted.length, 0);
  console.log('  ✓ a reused numeric marketId cannot resume the wrong symbol');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      active: [['order-1', { levelIndex: 'oops', side: 'DROP', price: null, sizeBase: -2 }]],
    }),
    (error) => error.code === 'UNSAFE_RESUME' && /挂单记录不完整/.test(error.message),
  );
  assert.equal(exchange.adopted.length, 0);
  console.log('  ✓ malformed active orders fail closed before exchange adoption');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      recovery: true,
      config: { ...runningGrid.config, mode: 'recovery', spacing: 100, gridCount: null },
      active: [['order-1', {
        levelIndex: 2, side: 'sell', price: 62000, sizeBase: 0.001,
        recovery: true, reduceOnly: false, opening: true,
      }]],
    }),
    (error) => error.code === 'UNSAFE_RESUME' && /挂单记录不完整/.test(error.message),
  );
  assert.equal(exchange.adopted.length, 0, '回收快照不得把普通开仓单在本地重标为 reduce-only');
  console.log('  ✓ recovery snapshot requires every adopted order to be a proven reduce-only close');
}

{
  const exchange = new ResumeExchange();
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({
      ...runningGrid,
      config: { ...runningGrid.config, outOfRangeAction: 'recover' },
      active: [['grid-recovery-unsafe', {
        levelIndex: -1, side: 'buy', price: 59000, sizeBase: 0.001,
        recovery: true, reduceOnly: false, opening: true,
      }]],
    }),
    (error) => error.code === 'UNSAFE_RESUME' && /挂单记录不完整/.test(error.message),
  );
  assert.equal(exchange.adopted.length, 0, '普通网格中的回收腿同样必须被证明为 reduce-only');
  console.log('  ✓ every recovery-tagged snapshot order must be a proven reduce-only close');
}

{
  const exchange = new ResumeExchange();
  exchange.getMarkets = async () => [
    { marketId: 7, displayName: 'BTC-USD', symbol: 'BTC' },
    { marketId: 8, displayName: 'BTC-EUR', symbol: 'BTC' },
  ];
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({ ...runningGrid, config: { ...runningGrid.config, displayName: 'BTC' } }),
    (error) => error.code === 'UNSAFE_RESUME' && /匹配到多个市场/.test(error.message),
  );
  console.log('  ✓ ambiguous market names cannot select the first matching symbol');
}

{
  const exchange = new DePaperExchange({ startBalance: 10000 });
  exchange.dataSource = 'synthetic';
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  const bot = new GridBot(exchange);
  const legacyPaper = { ...runningGrid, exchangeMode: undefined, exchangeState: undefined };
  legacyPaper.active = [['paper-1', runningGrid.active[0][1]]];
  await assert.rejects(
    () => bot.resume(legacyPaper),
    (error) => error.code === 'UNSAFE_RESUME' && /模拟盘快照缺少完整的余额\/仓位账本/.test(error.message),
  );
  console.log('  ✓ legacy paper snapshot cannot silently resume with an empty ledger');
}

{
  const exchange = new DePaperExchange({ startBalance: 10000 });
  exchange.dataSource = 'synthetic';
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  const bot = new GridBot(exchange);
  await assert.rejects(
    () => bot.resume({ ...runningGrid, exchangeMode: 'paper', exchangeState: {} }),
    (error) => error.code === 'UNSAFE_RESUME' && /模拟盘快照缺少完整/.test(error.message),
  );
  console.log('  ✓ malformed paper ledger fails closed');
}

{
  const beforeExchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  beforeExchange.dataSource = 'synthetic';
  beforeExchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  beforeExchange.prices.set(7, 63000);
  beforeExchange.balance = 9876;
  beforeExchange.positions.set(7, { sizeBase: 0.2, entryPrice: 62000, marketName: 'BTC-USD' });
  const beforeBot = new GridBot(beforeExchange);
  beforeBot.config = { ...runningGrid.config };
  beforeBot.pendingAction = { type: 'cancel-orders', marketName: 'BTC-USD', at: 1 };
  const snapshot = JSON.parse(JSON.stringify(beforeBot.snapshot()));

  const afterExchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  afterExchange.dataSource = 'synthetic';
  afterExchange.markets.set(9, { marketId: 9, displayName: 'BTC-USD' });
  afterExchange.prices.set(9, 63000);
  const afterBot = new GridBot(afterExchange);
  afterBot.restore(snapshot);
  afterBot.restoreExchangeState(snapshot, { allowUnfinished: true });

  assert.equal(afterExchange.balance, 9876);
  assert.equal(afterExchange.positions.get(9)?.sizeBase, 0.2);
  assert.match(afterBot.tradingBlock, /未完成的 cancel-orders/);
  console.log('  ✓ blocked paper snapshot restores its ledger without executing unfinished intent');
}

{
  const exchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  exchange.dataSource = 'synthetic';
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD', minOrderSize: 0.001, stepPrice: 1 });
  exchange.prices.set(7, 63000);
  exchange.positions.set(7, { sizeBase: 0.2, entryPrice: 62000, marketName: 'BTC-USD' });
  exchange.fetchOpenOrders = async () => { throw new Error('injected open-order outage'); };
  let placements = 0;
  exchange.placeLimitOrder = async () => { placements += 1; return { orderId: `paper-${placements}` }; };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await assert.rejects(
    () => bot.startRecovery({ marketId: 7, spacing: 100, sizeBase: 0.01 }),
    /injected open-order outage/,
  );
  assert.equal(placements, 0, '无法读取遗留挂单时不得叠加新的回收阶梯');
  assert.match(bot.tradingBlock, /无法核对遗留挂单/);
  console.log('  ✓ recovery start fails closed when existing orders cannot be reconciled');
}

{
  const exchange = new ResumeExchange();
  const events = [];
  exchange.getPrice = async () => 100;
  exchange.getPosition = () => ({ sizeBase: 1, entryPrice: 90, unrealizedPnl: 10, leverage: 3 });
  exchange.refreshPosition = async () => exchange.getPosition();
  let cancelled = false;
  exchange.fetchOpenOrders = async () => cancelled
    ? []
    : [{ orderId: 'unknown-opening-buy', price: 90, side: 'buy' }];
  exchange.cancelAll = async () => { events.push('cancel-all'); cancelled = true; return true; };
  exchange.placeLimitOrder = async (order) => {
    events.push({ ...order });
    return { orderId: `recovery-${events.length}` };
  };
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await bot.startRecovery({ marketId: 7, spacing: 10, sizeBase: 0.5 });

  const placements = events.filter((event) => typeof event === 'object');
  assert.equal(events[0], 'cancel-all', '启动只减仓回收前必须先撤销无法证明 reduce-only 的遗留订单');
  assert.equal(exchange.adopted.some((order) => order.orderId === 'unknown-opening-buy'), false);
  assert.ok(placements.length > 0);
  assert.ok(
    placements.every((order) => order.side === 'sell' && order.reduceOnly === true),
    '多仓回收只能重新挂出经本进程确认的 reduce-only 卖单',
  );
  bot._stopReconcileTimer();
  console.log('  ✓ recovery start cancels unknown orders before rebuilding a reduce-only ladder');
}

{
  const exchange = new ResumeExchange();
  exchange.getPosition = () => null;
  let refreshed = 0, cancelled = 0;
  exchange.refreshPosition = async () => {
    refreshed += 1;
    return { sizeBase: 1, entryPrice: 90, unrealizedPnl: 10, leverage: 3 };
  };
  exchange.getPrice = async () => 100;
  exchange.cancelAll = async () => { cancelled += 1; return true; };
  exchange.fetchOpenOrders = async () => [];
  exchange.placeLimitOrder = async (order) => ({ orderId: `recovery-${order.levelIndex}` });
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });

  await bot.startRecovery({ marketId: 7, spacing: 10, sizeBase: 0.5 });

  assert.ok(refreshed >= 2, '撤单前后都必须以权威持仓为准');
  assert.equal(cancelled, 1, '缓存为空但真实有仓时不能提前拒绝回收');
  bot._stopReconcileTimer();
  console.log('  ✓ recovery start refreshes the authoritative position before cancellation');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{ orderId: 'unknown-no-price', price: undefined, side: 'buy' }];
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.recovery = true;
  bot.config = {
    marketId: 7, displayName: 'BTC-USD', mode: 'recovery',
    sizeBase: 0.5, spacing: 10, lower: null, upper: null, gridCount: null,
  };

  await assert.rejects(
    () => bot.reconcileOpenOrders({ strict: true }),
    /无法证明为 reduce-only 的未跟踪挂单 unknown-no-price/,
  );
  assert.match(bot.tradingBlock, /无法证明为 reduce-only/);
  console.log('  ✓ recovery rejects unknown orders even when exchange price metadata is malformed');
}

{
  const exchange = new ResumeExchange();
  exchange.fetchOpenOrders = async () => [{ orderId: 'unknown-grid-recovery', price: 90, side: 'buy' }];
  const bot = new GridBot(exchange, { onChange: () => {}, onCriticalChange: () => true });
  bot.running = true;
  bot.config = {
    marketId: 7, displayName: 'BTC-USD', mode: 'long', lower: 100, upper: 120,
    gridCount: 2, sizeBase: 1, leverage: 3, outOfRangeAction: 'recover',
  };
  bot.grid = { levels: [100, 110, 120], spacing: 10, count: 2 };

  await assert.rejects(
    () => bot.reconcileOpenOrders({ strict: true }),
    /无法证明为 reduce-only 的未跟踪挂单 unknown-grid-recovery/,
  );
  assert.equal(exchange.adopted.some((order) => order.orderId === 'unknown-grid-recovery'), false);
  assert.match(bot.tradingBlock, /无法证明为 reduce-only/);
  console.log('  ✓ grid recovery cannot relabel an unknown off-grid order as reduce-only');
}

for (const [name, PaperExchange] of [
  ['Decibel', DePaperExchange],
  ['Extended', ExPaperExchange],
  ['RISEx', RsPaperExchange],
]) {
  const beforeExchange = new PaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  beforeExchange.dataSource = 'synthetic';
  beforeExchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  beforeExchange.prices.set(7, 63000);
  beforeExchange.balance = 9876;
  beforeExchange.realizedPnl = -124;
  beforeExchange.positions.set(7, { sizeBase: 0.1, entryPrice: 62000, marketName: 'BTC-USD' });
  beforeExchange._seq = 2;

  const beforeBot = new GridBot(beforeExchange);
  beforeBot.running = true;
  beforeBot.config = { ...runningGrid.config, mode: 'long' };
  beforeBot.active.set('paper-7', {
    levelIndex: 3, side: 'sell', price: 63000, sizeBase: 0.1,
    opening: false, reduceOnly: true, recovery: false, placedAt: 100,
  });
  beforeBot.fills = [...runningGrid.fills];
  const snapshot = JSON.parse(JSON.stringify(beforeBot.snapshot()));

  const afterExchange = new PaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  afterExchange.dataSource = 'synthetic';
  afterExchange.markets.set(9, { marketId: 9, displayName: 'BTC-USD' });
  afterExchange.prices.set(9, 63000);
  const afterBot = new GridBot(afterExchange);
  await afterBot.resume(snapshot);

  assert.equal(afterBot.config.marketId, 9, `${name}: 重启后应按市场名称解析新 marketId`);
  assert.equal(afterExchange.balance, 9876, `${name}: 模拟余额必须恢复`);
  assert.equal(afterExchange.realizedPnl, -124, `${name}: 已实现盈亏必须恢复`);
  assert.deepEqual(afterExchange.positions.get(9), { sizeBase: 0.1, entryPrice: 62000, marketName: 'BTC-USD' }, `${name}: 模拟仓位必须恢复并重映射 marketId`);
  assert.equal(afterExchange.orders.get('paper-7')?.reduceOnly, true, `${name}: 恢复的平仓单必须保持 reduce-only`);
  assert.equal(afterExchange._seq, 8, `${name}: 订单序号必须前移，不能覆盖恢复订单`);
  const next = await afterExchange.placeLimitOrder({ marketId: 9, levelIndex: 4, side: 'buy', price: 62000, sizeBase: 0.001 });
  assert.equal(next.orderId, 'paper-8', `${name}: 新订单 ID 不能覆盖已恢复的 paper-7`);
  assert.deepEqual(afterBot.fills, runningGrid.fills, `${name}: 近期成交必须恢复`);
  afterBot._stopReconcileTimer();
  console.log(`  ✓ ${name} paper ledger and order semantics survive restart`);
}

for (const [name, PaperExchange] of [
  ['Decibel', DePaperExchange],
  ['Extended', ExPaperExchange],
  ['RISEx', RsPaperExchange],
]) {
  const exchange = new PaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  exchange._setMarkets([
    { marketId: 1, displayName: 'BTC-USD', name: 'BTC-USD', lastPrice: 60000 },
    { marketId: 2, displayName: 'ETH-USD', name: 'ETH-USD', lastPrice: 3000 },
  ]);
  exchange.positions.set(2, { sizeBase: 1, entryPrice: 2900, marketName: 'ETH-USD' });
  exchange.orders.set('paper-1', { orderId: 'paper-1', marketId: 1, side: 'buy', price: 59000, sizeBase: 0.001 });
  exchange._setMarkets([
    { marketId: 1, displayName: 'ETH-USD', name: 'ETH-USD', lastPrice: 3000 },
    { marketId: 2, displayName: 'BTC-USD', name: 'BTC-USD', lastPrice: 60000 },
  ]);

  assert.equal(exchange.positions.get(1)?.marketName, 'ETH-USD', `${name}: ID 对调后非当前仓位仍须绑定 ETH`);
  assert.equal(exchange.positions.has(2), false, `${name}: ID 对调不能把 ETH 仓错绑到 BTC`);
  assert.equal(exchange.orders.get('paper-1')?.marketId, 2, `${name}: ID 对调后 BTC 挂单须随稳定名称迁移`);

  const bot = new GridBot(exchange);
  bot.config = { ...runningGrid.config, marketId: 1, displayName: 'BTC-USD' };
  await bot.refreshMarketMapping();
  assert.equal(bot.config.marketId, 2, `${name}: 运行中 bot config 应刷新为 BTC 新 ID`);
  assert.equal(exchange.positions.get(1)?.marketName, 'ETH-USD', `${name}: config 刷新不得二次搬运 ETH 仓位`);
  console.log(`  ✓ ${name} market-ID swaps preserve every paper position and order`);
}

for (const [name, PaperExchange] of [
  ['Decibel', DePaperExchange],
  ['Extended', ExPaperExchange],
  ['RISEx', RsPaperExchange],
]) {
  const exchange = new PaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  exchange.dataSource = 'synthetic';
  exchange._setMarkets([{ marketId: 7, displayName: 'BTC-USD', name: 'BTC-USD', lastPrice: 100 }]);
  exchange.positions.set(7, { sizeBase: 0.15, entryPrice: 90, marketName: 'BTC-USD' });
  exchange.orders.set('paper-1', { orderId: 'paper-1', marketId: 7, side: 'sell', price: 101, sizeBase: 0.1, reduceOnly: true });
  exchange.orders.set('paper-2', { orderId: 'paper-2', marketId: 7, side: 'sell', price: 102, sizeBase: 0.1, reduceOnly: true });
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));
  exchange._matchFills(7, 100, 103);
  assert.equal(exchange.positions.get(7)?.sizeBase, 0, `${name}: 多个 reduce-only 单同 tick 成交不得反向开仓`);
  assert.ok(Math.abs(fills.reduce((sum, fill) => sum + fill.sizeBase, 0) - 0.15) < 1e-9, `${name}: reduce-only 总成交量不得超过仓位`);
  console.log(`  ✓ ${name} reduce-only fills cannot cross through zero`);
}

{
  const exchange = new DePaperExchange({ startBalance: 10000, tickMs: 60000, pollMs: 60000 });
  exchange.dataSource = 'synthetic';
  exchange.markets.set(7, { marketId: 7, displayName: 'BTC-USD' });
  exchange.prices.set(7, 61000);
  const captured = [];
  const capture = (snapshot) => { captured.push(snapshot); return true; };
  const bot = new GridBot(exchange, { onChange: capture, onCriticalChange: capture });
  bot.running = true;
  bot.config = { ...runningGrid.config, mode: 'long' };
  bot.grid = { levels: [60000, 61000, 62000, 63000, 64000], spacing: 1000, count: 4 };
  bot.active.set('paper-1', { levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001, opening: true, reduceOnly: false });
  exchange.orders.set('paper-1', { orderId: 'paper-1', marketId: 7, levelIndex: 1, side: 'buy', price: 61000, sizeBase: 0.001, reduceOnly: false });
  bot.ex.on('fill', bot._onFill);
  exchange._seq = 2;

  exchange._matchFills(7, 62000, 61000);
  await new Promise((resolve) => setImmediate(resolve));

  const replacement = captured.at(-1)?.active?.find(([, order]) => order.side === 'sell');
  assert.ok(replacement, '成交后补挂的反向单必须进入持久快照');
  assert.equal(replacement[1].reduceOnly, true, 'long 模式补挂卖单必须保持 reduce-only');
  console.log('  ✓ fill replacement is persisted after asynchronous placement');
}
