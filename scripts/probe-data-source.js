// 一次性诊断脚本：探测 Decibel / RISEx 的 paper 模式是否接上了真实交易所行情。
// 强制以 paper 模式运行（覆盖 .env 的 mode），只读公开行情端点 —— 不需要私钥、不会真实下单。
// 判据：适配器的 dataSource 字段（'real' = 已接上真实行情，'synthetic' = 合成随机回退）。
// 运行：node scripts/probe-data-source.js
import { getConfig } from '../src/config.js';
import { createExchange as createDeExchange } from '../src/exchange/de/index.js';
import { createExchange as createRsExchange } from '../src/exchange/rs/index.js';

const TIMEOUT_MS = 30000;
const withTimeout = (p, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（${TIMEOUT_MS}ms，可能网络/代理不通）`)), TIMEOUT_MS)),
]);

const mask = (v) => (v ? `已配置（${String(v).length} 字符）` : '未配置');

async function probe(name, cfg, factory) {
  console.log(`\n=== ${name} ===`);
  console.log(`  .env mode = ${cfg.mode}`);
  console.log(`  network   = ${cfg.network}`);
  console.log(`  apiUrl    = ${cfg.apiUrl}`);
  if (cfg.apiKey != null) console.log(`  apiKey    = ${mask(cfg.apiKey)}`);

  // 强制 paper：跳过 live 凭据校验，绝不真实下单
  const ex = factory({ ...cfg, mode: 'paper' });
  try {
    await withTimeout(ex.init(), `${name} init`);
    const markets = await ex.getMarkets();
    const real = ex.dataSource === 'real';
    console.log(`  dataSource= ${ex.dataSource}   ${real ? '✅ 真实行情' : '⚠️ 合成随机行情（未接上交易所）'}`);
    console.log(`  markets   = ${markets.length}`);
    for (const m of markets.slice(0, 4)) {
      const price = await ex.getPrice(m.marketId).catch(() => null);
      console.log(`    • ${m.displayName || m.name || m.marketId}: ${price != null ? '$' + price : '(无价)'}`);
    }
  } catch (e) {
    console.log(`  ❌ 探测失败: ${e.message}`);
  } finally {
    if (typeof ex.stop === 'function') { try { ex.stop(); } catch { /* noop */ } }
  }
}

const cfg = getConfig();
console.log('行情探测（强制 paper 模式，只读公开端点，不下单）');
await probe('Decibel', cfg.de, createDeExchange);
await probe('RISEx', cfg.rs, createRsExchange);
process.exit(0);
