// 三交易所整合配置加载器
// 支持全局代理（GLOBAL_PROXY）+ 各交易所独立代理覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有交易所的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  // ── Decibel ──────────────────────────────────────────────────────────────
  const deNet = (process.env.DE_NETWORK || 'mainnet').toLowerCase();
  const deDefaults =
    deNet === 'testnet'
      ? { api: 'https://api.testnet.aptoslabs.com/decibel' }
      : { api: 'https://api.mainnet.aptoslabs.com/decibel' };

  const de = {
    mode: (process.env.DE_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: deNet,
    apiKey: process.env.DECIBEL_API_KEY || '',
    privateKey: process.env.DECIBEL_PRIVATE_KEY || '',
    subaccount: process.env.DECIBEL_SUBACCOUNT || '',
    apiUrl: (process.env.DECIBEL_API_URL || deDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.DECIBEL_PROXY || globalProxy,
  };

  // ── Extended ──────────────────────────────────────────────────────────────
  const exNet = (process.env.EX_NETWORK || 'mainnet').toLowerCase();
  const exDefaults =
    exNet === 'testnet'
      ? { api: 'https://api.starknet.sepolia.extended.exchange' }
      : { api: 'https://api.starknet.extended.exchange' };

  const ex = {
    mode: (process.env.EX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: exNet,
    apiKey: process.env.EXTENDED_API_KEY || '',
    vault: process.env.EXTENDED_VAULT || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || exDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.EXTENDED_PROXY || globalProxy,
  };

  // ── RISEx ─────────────────────────────────────────────────────────────────
  const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
  const rsDefaults =
    rsNet === 'testnet'
      ? { api: 'https://api.testnet.rise.trade', ws: 'wss://ws.testnet.rise.trade' }
      : { api: 'https://api.risex.trade', ws: 'wss://ws.risex.trade' };

  const rs = {
    mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: rsNet,
    account: process.env.ACCOUNT_ADDRESS || '',
    signerKey: process.env.SIGNER_PRIVATE_KEY || '',
    apiUrl: process.env.RISEX_API_URL || rsDefaults.api,
    wsUrl: process.env.RISEX_WS_URL || rsDefaults.ws,
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.RISEX_PROXY || globalProxy,
  };

  // ── 登录认证 ──────────────────────────────────────────────────────────────
  const _pwRev = Number(process.env.LOGIN_PASSWORD_REV);
  const auth = {
    email: process.env.LOGIN_EMAIL || '',                   // 白名单邮箱；可空=首次登录时自动捕获并持久化
    passwordHash: process.env.LOGIN_PASSWORD_HASH || '',    // scrypt:N:r:p:salt:hash（node src/auth.js hash 生成）
    passwordRev: Number.isFinite(_pwRev) && _pwRev > 0 ? Math.floor(_pwRev) : 1, // 密码版本号；改密递增使旧会话失效
    sessionSecret: process.env.SESSION_SECRET || '',        // 签名 cookie 密钥；空则启动时随机（重启失效登录）
    ttlHours: Number(process.env.SESSION_TTL_HOURS || 720), // 会话有效期（小时），默认 30 天
    cookieSecure: (process.env.SESSION_COOKIE_SECURE || '').toLowerCase() === 'true', // HTTPS 部署时设 true
  };

  return {
    port: Number(process.env.PORT || 8080),
    // SECURITY: bind to loopback by default so the dashboard (which can start/stop
    // LIVE trading and edit .env) is NOT exposed to the local network. Set
    // HOST=0.0.0.0 explicitly only if you understand the risk and add your own auth.
    host: process.env.HOST || '127.0.0.1',
    globalProxy,
    auth,
    de,
    ex,
    rs,
  };
}

export const ROOT = root;
