// 三交易所整合服务器
// 路由规则：
//   /api/de/*  → Decibel 交易所
//   /api/ex/*  → Extended 交易所
//   /api/rs/*  → RISEx 交易所
//   /api/overview → 三交易所总览（余额+盈亏）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, ROOT } from './config.js';
import { createExchange as createDeExchange } from './exchange/de/index.js';
import { createExchange as createExExchange } from './exchange/ex/index.js';
import { createExchange as createRsExchange } from './exchange/rs/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot, flushNow } from './persist.js';
import { createAiService } from './ai/service.js';
import { createAuth, clientIp } from './auth.js';
import { listExchangeConfigs, getExchangeConfig, upsertExchangeConfig, deleteExchangeConfig } from './db.js';
import { setEnvKey, removeEnvKey } from './envfile.js';

// ── 启动配置 ─────────────────────────────────────────────────────────────────
// 配置同步：数据库（持久卷）中的交易所配置覆盖到 process.env。
// Dokploy/容器部署下 .env 不随容器持久化，而数据库挂载在持久卷上，因此以数据库
// 为配置真相源——启动时把库里的模式/网络/凭据写回环境变量，供 getConfig() 读取。
// 首次部署（库为空）则沿用 Dokploy 注入的环境变量。
try {
  for (const c of listExchangeConfigs()) {
    if (!c.fields || !Object.keys(c.fields).length) continue;
    const kn = { de: ['DE_MODE', 'DE_NETWORK'], ex: ['EX_MODE', 'EX_NETWORK'], rs: ['RS_MODE', 'RS_NETWORK'] }[c.exchange];
    if (!kn) continue;
    process.env[kn[0]] = c.mode;
    process.env[kn[1]] = c.network;
    for (const [k, v] of Object.entries(c.fields)) process.env[k] = String(v);
  }
} catch { /* 数据库未就绪（首次运行）则忽略，沿用环境变量 */ }

const cfg = getConfig();

// ── 实盘凭据预检查：缺什么直接列出来，不甩堆栈吓人 ─────────────────────────────
{
  const missing = [];
  if (cfg.de.mode === 'live') {
    if (!cfg.de.apiKey) missing.push(['Decibel ', 'DECIBEL_API_KEY', '在 geomi.dev 免费创建']);
    if (!cfg.de.privateKey) missing.push(['Decibel ', 'DECIBEL_PRIVATE_KEY', '在 app.decibel.trade/api 创建 API 钱包']);
  }
  if (cfg.ex.mode === 'live') {
    if (!cfg.ex.apiKey) missing.push(['Extended', 'EXTENDED_API_KEY', 'app.extended.exchange → API Management']);
    if (!cfg.ex.vault) missing.push(['Extended', 'EXTENDED_VAULT', '同上，创建 API Key 时一并显示']);
    if (!cfg.ex.starkPrivateKey) missing.push(['Extended', 'EXTENDED_STARK_PRIVATE_KEY', '同上，只显示一次务必保存']);
  }
  if (cfg.rs.mode === 'live') {
    if (!cfg.rs.account) missing.push(['RISEx   ', 'ACCOUNT_ADDRESS', 'RISEx 应用的账户 / API 设置']);
    if (!cfg.rs.signerKey) missing.push(['RISEx   ', 'SIGNER_PRIVATE_KEY', 'RISEx 应用的账户 / API 设置']);
  }
  if (missing.length) {
    console.error('\n[启动失败] 有交易所被设为 live 实盘模式，但 .env 里还缺以下凭据：\n');
    for (const [ex, key, where] of missing) {
      console.error(`  ${ex}  缺 ${key}`);
      console.error(`            获取方式：${where}`);
    }
    console.error('\n解决办法（二选一）：');
    console.error('  1. 用记事本打开项目里的 .env，补齐上面列出的字段');
    console.error('     （详细获取教程见 README.md 第七节）');
    console.error('  2. 暂时不实盘：把 .env 里对应的 DE_MODE / EX_MODE / RS_MODE 改回 paper\n');
    process.exit(1);
  }
}

// ── 登录认证初始化 ───────────────────────────────────────────────────────────
// SESSION_SECRET 缺失时随机生成（仅本进程有效，重启即失效所有登录），并警告。
let sessionSecret = cfg.auth.sessionSecret;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[安全] 未配置 SESSION_SECRET，本次使用随机密钥：重启后所有登录将失效。建议在 .env 设置固定 SESSION_SECRET。');
}
const auth = createAuth({
  email: cfg.auth.email,
  passwordHash: cfg.auth.passwordHash,
  sessionSecret,
  ttlMs: (cfg.auth.ttlHours || 720) * 3600 * 1000,
  cookieSecure: cfg.auth.cookieSecure,
});
if (!auth.configured) {
  console.error('\n[启动失败] 登录系统尚未配置（这是必需的安全步骤）。\n');
  console.error('  请编辑项目根目录的 .env，补齐：');
  console.error('    1) LOGIN_EMAIL=jaychougo@gmail.com        （白名单邮箱）');
  console.error('    2) LOGIN_PASSWORD_HASH=scrypt:...         （运行 npm run hash 生成，把整行贴进来）');
  console.error('    3) SESSION_SECRET=任意长随机串            （推荐，保证重启后不掉登录）\n');
  process.exit(1);
}

// ── 代理设置 ─────────────────────────────────────────────────────────────────
const proxyResult = await setupProxies(cfg);
if (proxyResult.used) {
  console.log('[代理] 已启用: ' + proxyResult.used);
  console.log('[代理检测] 正在验证代理可用性...');
  const chk = await checkProxy();
  if (chk.ok) {
    console.log('[代理检测] ✓ 代理正常，当前出口 IP: ' + chk.ip);
  } else {
    console.error('[代理检测] ✗ 代理无法联网：' + chk.error);
    const hasLive = cfg.de.mode === 'live' || cfg.ex.mode === 'live' || cfg.rs.mode === 'live';
    if (hasLive) {
      console.error('  实盘模式已中止启动，以免在断网状态下运行造成挂单失控。');
      process.exit(1);
    } else {
      console.error('  模拟模式将继续运行，但可能拿不到真实行情。');
    }
  }
} else {
  console.log('[代理] 未配置（直连模式）');
}

// ── 创建三个交易所和机器人 ────────────────────────────────────────────────────
const deExchange = createDeExchange(cfg.de);
const exExchange = createExExchange(cfg.ex);
const rsExchange = createRsExchange(cfg.rs);

const deBot = new GridBot(deExchange, { onChange: (s) => saveSnapshot('de', s) });
const exBot = new GridBot(exExchange, { onChange: (s) => saveSnapshot('ex', s) });
const rsBot = new GridBot(rsExchange, { onChange: (s) => saveSnapshot('rs', s) });

// Restore cumulative stats / config from the previous run (display continuity).
// Trading does NOT auto-resume; stray-order cleanup happens after each exchange
// finishes init (see below).
deBot.restore(loadSnapshot('de'));
exBot.restore(loadSnapshot('ex'));
rsBot.restore(loadSnapshot('rs'));

// Belt-and-suspenders: ensure every exchange always has an 'error' listener so a
// stray emit can never crash the process (the GridBot also attaches one).
for (const ex of [deExchange, exExchange, rsExchange]) {
  ex.on('error', (e) => { try { console.error('[交易所错误] ' + (e?.message || e)); } catch {} });
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({
  bots: { de: deBot, ex: exBot, rs: rsBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange },
});
aiService.start();

// SSE 客户端集合（按交易所分组）
const deClients = new Set();
const exClients = new Set();
const rsClients = new Set();

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    let b = '', n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) { done = true; try { req.destroy(); } catch { /* ignore */ } resolve({}); return; }
      b += c;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// ── 交易所实盘凭据字段定义（设置页面"交易所配置"管理用） ───────────────────
const EXCHANGE_FIELDS = {
  de: { name: 'Decibel', modeKey: 'DE_MODE', netKey: 'DE_NETWORK', creds: [
    { key: 'DECIBEL_API_KEY', label: 'API Key', secret: false },
    { key: 'DECIBEL_PRIVATE_KEY', label: 'API 钱包私钥（Ed25519）', secret: true },
    { key: 'DECIBEL_SUBACCOUNT', label: 'Trading Account 地址（0x…）', secret: false },
  ]},
  ex: { name: 'Extended', modeKey: 'EX_MODE', netKey: 'EX_NETWORK', creds: [
    { key: 'EXTENDED_API_KEY', label: 'API Key', secret: false },
    { key: 'EXTENDED_VAULT', label: 'Vault ID', secret: false },
    { key: 'EXTENDED_STARK_PRIVATE_KEY', label: 'Stark 私钥', secret: true },
    { key: 'EXTENDED_STARK_PUBLIC_KEY', label: 'Stark 公钥', secret: false },
  ]},
  rs: { name: 'RISEx', modeKey: 'RS_MODE', netKey: 'RS_NETWORK', creds: [
    { key: 'ACCOUNT_ADDRESS', label: '账户地址', secret: false },
    { key: 'SIGNER_PRIVATE_KEY', label: '签名私钥', secret: true },
  ]},
};

/** 脱敏返回交易所配置：只暴露"是否已设置"，绝不回传凭据明文。 */
function maskExchangeConfig(c) {
  const def = EXCHANGE_FIELDS[c.exchange];
  const fields = {};
  let configured = false;
  if (def) {
    for (const f of def.creds) {
      const has = !!(c.fields && c.fields[f.key]);
      if (has) configured = true;
      fields[f.key] = { set: has, secret: f.secret, label: f.label };
    }
  }
  return { exchange: c.exchange, name: def?.name, mode: c.mode, network: c.network, configured, fields, updatedAt: c.updatedAt || null };
}

// ── 交易所路由处理器工厂 ───────────────────────────────────────────────────────
function makeExchangeHandler(prefix, bot, exchange, exCfg, clients, name) {
  return async (req, res, subPath, url) => {
    if (subPath === '/markets') {
      return send(res, 200, {
        exchange: name,
        mode: exCfg.mode,
        dataSource: exchange.dataSource || (exCfg.mode === 'live' ? 'real' : 'synthetic'),
        network: exchange.network || exCfg.network,
        apiUrl: exchange.apiUrl || exCfg.apiUrl,
        markets: await exchange.getMarkets(),
      });
    }

    if (subPath === '/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* tolerate */ }
      let price = null;
      try { price = await exchange.getPrice(marketId); } catch {}
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles)
        : {
            trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。',
          };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (subPath === '/state') return send(res, 200, bot.getState());

    if (subPath === '/start' && req.method === 'POST') {
      try { return send(res, 200, await bot.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stop' && req.method === 'POST') {
      try { return send(res, 200, await bot.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/adjust' && req.method === 'POST') {
      try { return send(res, 200, await bot.adjustRange(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reset' && req.method === 'POST') {
      try { return send(res, 200, await bot.resetStats()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/cancel-orders' && req.method === 'POST') {
      try { return send(res, 200, await bot.cancelAllOrders()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/start-recovery' && req.method === 'POST') {
      try { return send(res, 200, await bot.startRecovery(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 重新与交易所建立连接：重建客户端/解卡轮询/重启轮询循环。
    // 不撤单、不平仓、不动网格状态 —— 挂单照常被跟踪；重连成功后立刻对账一次。
    // 若该所启动时未连上导致续跑被跳过（快照仍为运行状态），重连成功后自动续跑接管挂单。
    if (subPath === '/reconnect' && req.method === 'POST') {
      try {
        if (typeof exchange.reconnect === 'function') await exchange.reconnect();
        else if (typeof exchange.init === 'function') await exchange.init();
        let resumed = false, resumeError = null;
        if (!bot.running) {
          const key = prefix.split('/').pop(); // '/api/ex' -> 'ex'
          const snap = loadSnapshot(key);
          if (snap?.running && snap?.config) {
            try {
              // marketId 是按连接会话编号的，可能已漂移：按市场名称重新解析
              const markets = await exchange.getMarkets();
              const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              const m = markets.find((x) => norm(x.displayName) === norm(snap.config.displayName) || norm(x.name) === norm(snap.config.displayName));
              if (m) snap.config.marketId = m.marketId;
              await bot.resume(snap);
              resumed = true;
              console.log(`[恢复] ${key.toUpperCase()} 重连成功后已自动续跑，接管挂单并完成对账。`);
            } catch (e) {
              resumeError = e?.message || String(e); // 续跑失败不撤单：挂单保留，可重启程序再试
              console.error(`[恢复] ${key.toUpperCase()} 重连后续跑失败（${resumeError}），挂单保留未动。`);
            }
          }
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        return send(res, 200, { ok: true, resumed, resumeError, state: bot.getState() });
      } catch (e) {
        return send(res, 500, { error: e?.message || String(e) });
      }
    }

    if (subPath === '/close-position' && req.method === 'POST') {
      try { const b = await readBody(req); return send(res, 200, await bot.closePositionNow(b && b.marketId)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(bot.getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    send(res, 404, { error: 'not found: ' + subPath });
  };
}

const deHandler = makeExchangeHandler('/api/de', deBot, deExchange, cfg.de, deClients, 'Decibel');
const exHandler = makeExchangeHandler('/api/ex', exBot, exExchange, cfg.ex, exClients, 'Extended');
const rsHandler = makeExchangeHandler('/api/rs', rsBot, rsExchange, cfg.rs, rsClients, 'RISEx');

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (request, res) => {
  const url = new URL(request.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ── 健康检查（公开，供 Dokploy/容器探活） ────────────────────────────
    if (p === '/api/health') return send(res, 200, { ok: true, ts: Date.now() });

    // ── 登录 / 认证（公开路由，无需登录） ────────────────────────────────
    if (p === '/api/auth/me') {
      const u = auth.verifyRequest(request);
      return send(res, 200, u ? { authed: true, email: u.email } : { authed: false });
    }
    if (p === '/api/login' && request.method === 'POST') {
      const ip = clientIp(request);
      if (auth.isLocked(ip)) {
        return send(res, 429, { error: `尝试次数过多，请 ${Math.ceil(auth.lockMsLeft(ip) / 60000)} 分钟后再试。` });
      }
      const { email, password } = await readBody(request);
      const ok = auth.checkLogin(email, password);
      auth.recordAttempt(ip, ok);
      if (!ok) return send(res, 401, { error: '邮箱或密码错误。' });
      const loginEmail = String(email).trim().toLowerCase();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': auth.issueSession(loginEmail).cookieHeader });
      res.end(JSON.stringify({ ok: true, email: loginEmail }));
      return;
    }
    if (p === '/api/logout' && request.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': auth.clearCookieHeader() });
      res.end('{"ok":true}');
      return;
    }

    // 登录页本身公开（其余静态资源与 API 仍受登录保护）
    if (p === '/login' || p === '/login.html') {
      const full = path.join(ROOT, 'public', 'login.html');
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(full).pipe(res);
        return;
      }
      return send(res, 404, { error: 'login page missing' });
    }

    // ── 其余一切（API / SSE / 静态主页）均需登录 ──────────────────────────
    if (!auth.verifyRequest(request)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: '未登录或会话已过期。', needLogin: true });
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }

    // ── 交易所实盘配置管理（DB + .env 双写） ─────────────────────────────
    if (p === '/api/exchange-config' && request.method === 'GET') {
      return send(res, 200, listExchangeConfigs().map(maskExchangeConfig));
    }
    {
      const m = p.match(/^\/api\/exchange-config\/(de|ex|rs)$/);
      if (m) {
        const ex = m[1], def = EXCHANGE_FIELDS[ex];
        if (request.method === 'GET') {
          const c = getExchangeConfig(ex) || { exchange: ex, mode: 'paper', network: 'mainnet', fields: {} };
          return send(res, 200, maskExchangeConfig(c));
        }
        if (request.method === 'POST') {
          const b = await readBody(request);
          const mode = b.mode === 'live' ? 'live' : 'paper';
          const network = b.network === 'testnet' ? 'testnet' : 'mainnet';
          const incoming = (b.fields && typeof b.fields === 'object') ? b.fields : {};
          const existing = getExchangeConfig(ex);
          const fields = {};
          for (const f of def.creds) {
            const v = incoming[f.key];
            if (typeof v === 'string' && v.trim()) {
              if (/\s/.test(v) || [...v].some((ch) => ch.charCodeAt(0) < 32)) {
                return send(res, 400, { error: `${f.label} 含非法字符（空白/控制字符）。` });
              }
              fields[f.key] = v.trim();
            } else if (existing && existing.fields[f.key]) {
              fields[f.key] = existing.fields[f.key]; // 留空 = 保留原值
            }
          }
          if (mode === 'live') {
            const missing = def.creds.filter((f) => !fields[f.key]).map((f) => f.label);
            if (missing.length) return send(res, 400, { error: `实盘模式需填写：${missing.join('、')}` });
          }
          upsertExchangeConfig(ex, { mode, network, fields });
          setEnvKey(def.modeKey, mode);
          setEnvKey(def.netKey, network);
          for (const f of def.creds) {
            if (fields[f.key]) setEnvKey(f.key, fields[f.key]);
            else removeEnvKey(f.key);
          }
          return send(res, 200, { ok: true, message: `${def.name} 配置已保存（写入数据库与 .env）。修改模式或凭据后需重启程序生效。` });
        }
        if (request.method === 'DELETE') {
          deleteExchangeConfig(ex);
          removeEnvKey(def.modeKey);
          removeEnvKey(def.netKey);
          for (const f of def.creds) removeEnvKey(f.key);
          return send(res, 200, { ok: true, message: `${def.name} 配置已删除（数据库与 .env）。重启程序生效。` });
        }
      }
    }

    // ── 总览 API ──────────────────────────────────────────────────────────
    if (p === '/api/overview') {
      return send(res, 200, {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
      });
    }

    // ── 总览 SSE 流 ───────────────────────────────────────────────────────
    if (p === '/api/overview/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // send the current snapshot immediately (don't leave the client blank
      // until the next 1s broadcast tick)
      const initial = {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
      };
      res.write(`data: ${JSON.stringify(initial, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
      const overviewClients = server._overviewClients;
      overviewClients.add(res);
      request.on('close', () => overviewClients.delete(res));
      return;
    }

    // ── AI 助手 API ───────────────────────────────────────────────────────
    if (p === '/api/ai/status') {
      return send(res, 200, aiService.status());
    }
    if (p === '/api/ai/test' && request.method === 'POST') {
      try { return send(res, 200, await aiService.test()); }
      catch (e) { return send(res, 200, { ok: false, error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/sentinel-run' && request.method === 'POST') {
      try {
        const r = await aiService.runSentinel();
        return send(res, 200, r || { error: aiService.sentinelError || '巡检失败' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      try { return send(res, 200, await aiService.runMarketAnalysis()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      try { return send(res, 200, await aiService.makeReport()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        return send(res, 200, await aiService.analyze(String(b.ex || 'de')));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/chat' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        return send(res, 200, await aiService.chatControl(b.message, Array.isArray(b.history) ? b.history : []));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }

    // ── 代理配置 API ──────────────────────────────────────────────────────
    if (p === '/api/proxy-check') {
      const result = await checkProxy();
      return send(res, 200, result);
    }

    if (p === '/api/proxy-config') {
      return send(res, 200, {
        global: process.env.GLOBAL_PROXY || '',
        de: process.env.DECIBEL_PROXY || '',
        ex: process.env.EXTENDED_PROXY || '',
        rs: process.env.RISEX_PROXY || '',
      });
    }

    if (p === '/api/env' && request.method === 'POST') {
      try {
        const { key, value } = await readBody(request);
        const PROXY_KEYS = ['GLOBAL_PROXY','DECIBEL_PROXY','EXTENDED_PROXY','RISEX_PROXY'];
        const AI_KEYS = ['AI_PROVIDER','AI_API_KEY','AI_BASE_URL','AI_MODEL','AI_MODEL_SMALL','AI_SENTINEL_MINUTES','AI_MARKET_MINUTES','AI_REPORT_HOUR','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','NOTIFY_WEBHOOK'];
        if (!PROXY_KEYS.includes(key) && !AI_KEYS.includes(key)) return send(res, 400, { error: '不允许修改该字段: ' + key });
        // SECURITY: the value is written verbatim into .env. Reject anything that
        // could break out of a single KEY=VALUE line (newlines / control chars)
        // — otherwise a crafted value could inject arbitrary env lines (e.g. flip
        // DE_MODE=live, set private keys). Per-key format validation below.
        const val = value == null ? '' : String(value).trim();
        if (val) {
          if (/\s/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32) || val.length > 500) {
            return send(res, 400, { error: '值包含非法字符（空白/换行/控制字符）或过长。' });
          }
          if (PROXY_KEYS.includes(key)) {
            // host:port | host:port:user:pass | scheme://[user:pass@]host:port
            const ok = /^[\w.-]+:\d{1,5}(:[^:\s@]+:[^:\s@]+)?$/.test(val)
              || /^(https?|socks[45]?):\/\/([^:@/\s]+(:[^@/\s]+)?@)?[\w.-]+:\d{1,5}\/?$/i.test(val);
            if (!ok) return send(res, 400, { error: '代理地址格式无效。示例：http://127.0.0.1:7890 或 socks5://user:pass@host:1080' });
          } else if (key === 'AI_PROVIDER') {
            if (!/^(openai|anthropic|gemini)$/i.test(val)) return send(res, 400, { error: 'AI_PROVIDER 只能是 openai / anthropic / gemini（OpenAI 兼容协议的服务商选 openai）。' });
          } else if (key === 'AI_SENTINEL_MINUTES' || key === 'AI_MARKET_MINUTES') {
            if (!/^\d{1,4}$/.test(val)) return send(res, 400, { error: '间隔必须是数字（分钟，0=关闭）。' });
          } else if (key === 'AI_REPORT_HOUR') {
            if (!/^\d{1,2}$/.test(val) || Number(val) > 23) return send(res, 400, { error: '日报时间必须是 0-23 的整点小时。' });
          } else if (key === 'AI_BASE_URL' || key === 'NOTIFY_WEBHOOK') {
            if (!/^https?:\/\/\S+$/i.test(val)) return send(res, 400, { error: '必须是 http(s):// 开头的 URL。' });
          }
        }
        // 更新内存中的环境变量
        if (val) process.env[key] = val; else delete process.env[key];
        // 写入 .env 文件
        const envFile = path.join(ROOT, '.env');
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const line = val ? `${key}=${val}` : `# ${key}=`;
        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
        fs.writeFileSync(envFile, content, 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── 交易所子路由 ──────────────────────────────────────────────────────
    if (p.startsWith('/api/de/')) {
      return await deHandler(request, res, p.slice('/api/de'.length), url);
    }
    if (p.startsWith('/api/ex/')) {
      return await exHandler(request, res, p.slice('/api/ex'.length), url);
    }
    if (p.startsWith('/api/rs/')) {
      return await rsHandler(request, res, p.slice('/api/rs'.length), url);
    }

    // ── 静态文件 ──────────────────────────────────────────────────────────
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server._overviewClients = new Set();

// ── SSE 推送定时器 ────────────────────────────────────────────────────────────
setInterval(() => {
  const stringify = (obj) =>
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  if (deClients.size > 0) {
    const data = `data: ${stringify(deBot.getState())}\n\n`;
    for (const r of deClients) { try { r.write(data); } catch { deClients.delete(r); } }
  }
  if (exClients.size > 0) {
    const data = `data: ${stringify(exBot.getState())}\n\n`;
    for (const r of exClients) { try { r.write(data); } catch { exClients.delete(r); } }
  }
  if (rsClients.size > 0) {
    const data = `data: ${stringify(rsBot.getState())}\n\n`;
    for (const r of rsClients) { try { r.write(data); } catch { rsClients.delete(r); } }
  }
  if (server._overviewClients.size > 0) {
    const deState = deBot.getState();
    const exState = exBot.getState();
    const rsState = rsBot.getState();
    const overview = {
      de: pick(deState, cfg.de.mode),
      ex: pick(exState, cfg.ex.mode),
      rs: pick(rsState, cfg.rs.mode),
    };
    const data = `data: ${stringify(overview)}\n\n`;
    for (const r of server._overviewClients) { try { r.write(data); } catch { server._overviewClients.delete(r); } }
  }
}, 1000);

function pick(s, mode) {
  return {
    running: s.running,
    mode,
    balance: s.balance,
    equity: s.equity,
    totalPnl: s.totalPnl,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    returnPct: s.returnPct,
    volume: s.volume,
    completedRungs: s.stats?.completedRungs ?? 0,
    openOrders: s.openOrders ?? 0,
    exchangeOpenOrders: s.exchangeOpenOrders ?? null,
    outOfRange: s.outOfRange ?? false,
    health: s.health ?? null,
    lastPrice: s.lastPrice,
    config: s.config,
  };
}

// ── 错误处理 ──────────────────────────────────────────────────────────────────
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用。`);
    console.error('请先关闭之前的程序窗口，或在 .env 里改 PORT=8081 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

// ── 初始化各交易所 ────────────────────────────────────────────────────────────
async function initExchange(exchange, name, exCfg) {
  try {
    await exchange.init();
    console.log(`[${name}] ✓ 连接成功 [${exCfg.mode.toUpperCase()} 模式]`);
  } catch (e) {
    console.error(`\n[${name}] ✗ 初始化失败：${e?.message || e}`);
    console.error(`  目标接口: ${exCfg.apiUrl}   网络: ${exCfg.network}`);
    const cause = e?.cause || {};
    const code = cause.code || '';
    if (code === 'ENOTFOUND') {
      console.error('  ➤ 域名解析失败：检查网络，或配置代理。');
    } else if (code === 'ECONNREFUSED' && String(cause.address || '').includes('127.0.0.1')) {
      console.error('  ➤ 本机代理端口连不上，检查代理软件是否开启。');
    } else if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(cause.message || '')) {
      console.error('  ➤ 连接超时，接口被网络拦截，或代理未正确转发。');
    }
    console.error(`  该交易所将以离线模式运行（行情可能使用合成数据）。\n`);
    // 不退出，让其他交易所继续工作
  }
}

await Promise.all([
  initExchange(deExchange, 'Decibel', cfg.de),
  initExchange(exExchange, 'Extended', cfg.ex),
  initExchange(rsExchange, 'RISEx', cfg.rs),
]);

// ── 崩溃恢复 / 续跑 ────────────────────────────────────────────────────────────
// If a bot was "running" when the process died, RESUME it: re-attach to the
// orders still resting on the exchange and keep managing the grid. If resume
// fails (e.g. exchange offline), fall back to cancelling stray orders so we
// never operate a half-known grid.
async function resumeIfWasRunning(bot, exchange, key) {
  const snap = loadSnapshot(key);
  if (!(snap?.running && snap?.config)) return;
  if (exchange.dataSource == null) {
    console.log(`[恢复] ${key.toUpperCase()} 交易所未连接，跳过续跑；保留挂单待下次连接。`);
    return;
  }
  try {
    console.log(`[恢复] 检测到 ${key.toUpperCase()} 上次为运行状态，正在接管续跑...`);
    await bot.resume(snap);
    console.log(`[恢复] ${key.toUpperCase()} 已续跑，接管挂单并完成对账。`);
  } catch (e) {
    console.error(`[恢复] ${key.toUpperCase()} 续跑失败（${e?.message || e}），改为撤销遗留挂单。`);
    await bot.recoverStrayOrders().catch(() => {});
  }
}
await Promise.all([
  resumeIfWasRunning(deBot, deExchange, 'de'),
  resumeIfWasRunning(exBot, exExchange, 'ex'),
  resumeIfWasRunning(rsBot, rsExchange, 'rs'),
]);

// After init, surface any LEFTOVER position so the dashboard can prompt the user
// (recovery ladder / re-grid / market close). Decibel & Extended RE-NUMBER their
// marketIds every run, so the persisted numeric id may point at the wrong market
// — re-resolve it by the market NAME, then start watching it so the position is
// polled into getState.
const _norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function detectOrphanPosition(bot, ex) {
  if (!bot.config?.displayName || ex.dataSource == null || typeof ex.getMarkets !== 'function') return;
  try {
    const markets = await ex.getMarkets();
    const want = _norm(bot.config.displayName);
    const m = markets.find((x) => _norm(x.displayName) === want || _norm(x.name) === want || _norm(x.symbol) === want);
    if (m) {
      bot.config.marketId = m.marketId;            // fix stale/ephemeral id -> current
      await ex.getPrice(m.marketId).catch(() => {}); // seed watch -> position gets polled
    }
  } catch { /* ignore */ }
}
await Promise.all([
  detectOrphanPosition(deBot, deExchange),
  detectOrphanPosition(exBot, exExchange),
  detectOrphanPosition(rsBot, rsExchange),
]);

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  三交易所整合网格机器人 已启动`);
  console.log(`  仪表盘: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  if (cfg.host === '0.0.0.0') console.log('  ⚠ 当前监听所有网卡(0.0.0.0)，局域网内可访问，请确保有防护。');
  console.log(`${'═'.repeat(52)}`);
  console.log(`  Decibel  [${cfg.de.mode.toUpperCase()}]  ${cfg.de.network}`);
  console.log(`  Extended [${cfg.ex.mode.toUpperCase()}]  ${cfg.ex.network}`);
  console.log(`  RISEx    [${cfg.rs.mode.toUpperCase()}]  ${cfg.rs.network}`);
  console.log(`${'─'.repeat(52)}`);
  if (cfg.de.mode === 'paper' || cfg.ex.mode === 'paper' || cfg.rs.mode === 'paper') {
    console.log('  ⚠ 部分交易所为模拟模式，不涉及真实资金。');
    console.log('    在 .env 中设置 DE_MODE/EX_MODE/RS_MODE=live 切换实盘。');
  }
  console.log('');
});

// ── 优雅关闭（容器收到 SIGTERM/SIGINT 时保存状态再退出）────────────────────────
// 容器编排（Dokploy/Docker）停止时发 SIGTERM；此处强制落盘快照，保证重启后能续跑。
let _shuttingDown = false;
function gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[关闭] 收到 ${sig}，保存状态后退出…`);
  try { saveSnapshot('de', deBot.snapshot()); } catch { /* ignore */ }
  try { saveSnapshot('ex', exBot.snapshot()); } catch { /* ignore */ }
  try { saveSnapshot('rs', rsBot.snapshot()); } catch { /* ignore */ }
  try { flushNow(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref(); // 兜底：5s 后强制退出
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
