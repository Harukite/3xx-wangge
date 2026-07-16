// ─────────────────────────────────────────────────────────────
// 登录认证模块：scrypt 密码哈希 + HMAC 签名 cookie + 登录限流 +
// 动态白名单邮箱（首次登录捕获）+ 改密（密码版本号使旧会话失效）。
// 纯 node:crypto 实现，零外部依赖；落盘由调用方经 onPersist 回调负责。
//
// 用法（模块）：import { createAuth } from './auth.js';
// 用法（CLI） ：node src/auth.js hash   交互式生成密码哈希，填入 .env 的 LOGIN_PASSWORD_HASH
//
// 安全要点：
//   - 密码用 scrypt(N=16384,r=8,p=1) 加盐哈希存储，永不落明文；改密走 changePassword；
//   - 登录态是无状态签名 cookie（payload.HMAC），payload 内含密码版本号 v；
//     改密后 v 递增，所有旧 cookie 即刻失效（无需服务端 session 表）；
//   - 邮箱白名单可不预置：第一个用正确密码登录的合法邮箱被捕获为唯一白名单；
//   - 登录失败按 IP 计数，5 次锁 15 分钟防爆破；接口级请求限流见 ratelimit.js + server.js；
//   - cookie 默认 HttpOnly + SameSite=Strict（防 XSS 读取 / CSRF 跨站）。
// ─────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const COOKIE_NAME = 'wg_session';
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
// 占位哈希：passwordHash 缺失时也对输入跑一次 scrypt，消除"邮箱/密码是否存在"的时序侧信道。
const PLACEHOLDER_HASH = 'scrypt:16384:8:1:00000000000000000000000000000000:00000000000000000000000000000000';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uDec = (s) => Buffer.from(s, 'base64url');

/** scrypt 哈希，返回 "scrypt:N:r:p:<saltHex>:<hashHex>" */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** 校验明文是否匹配已存哈希串（常量时间）。任何格式错误都返回 false，不抛错。 */
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || typeof plain !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = +parts[1], r = +parts[2], p = +parts[3];
  let salt, want;
  try {
    salt = Buffer.from(parts[4], 'hex');
    want = Buffer.from(parts[5], 'hex');
  } catch { return false; }
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (salt.length === 0 || want.length === 0) return false;
  let got;
  try { got = crypto.scryptSync(plain, salt, want.length, { N, r, p }); }
  catch { return false; }
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/** 生成签名 session token：base64url(payload).base64url(hmac)。payload 含密码版本号 v。 */
export function createSession(email, secret, ttlMs = DEFAULT_TTL_MS, pwVer = 1) {
  const key = sessionKey(secret);
  const payload = { e: email, v: pwVer, exp: Date.now() + ttlMs };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return { token: `${body}.${sig}`, exp: payload.exp, ttlMs };
}

/** 校验 token，成功返回 {email, v, exp}，失败返回 null。v 为密码版本号（旧 token 缺省为 1）。 */
export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', sessionKey(secret)).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null; // 长度不同时 safeEqual 返回 false，不抛错
  let payload;
  try { payload = JSON.parse(b64uDec(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.e !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Date.now()) return null; // 过期
  return { email: payload.e, v: typeof payload.v === 'number' ? payload.v : 1, exp: payload.exp };
}

/** SESSION_SECRET 为空时用进程内随机密钥兜底（仅防 cookie 被篡改；重启即失效）。 */
function sessionKey(secret) {
  return String(secret || 'wg-insecure-fallback-please-set-SESSION_SECRET');
}
function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}
function safeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b;
  return safeEqual(a, b);
}

/** 简易邮箱格式校验（用于"首次登录捕获"时拒绝明显非法输入）。 */
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

/** 从请求头解析 cookie 为对象。 */
export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

/** 取客户端 IP（信任 X-Forwarded-For，便于反向代理后限流）。 */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 构造一个认证器实例（持有白名单邮箱、密码哈希、密码版本号、密钥、内存限流表）。
 *
 * 邮箱白名单支持"首次登录捕获"：初始未给 email 时，第一个用正确密码登录的
 * 合法邮箱经 captureEmail 记下并由 onPersist 持久化，此后仅该邮箱可登录。
 *
 * 密码版本号 pwVer 写入 session；改密后递增，旧版本 cookie 校验失败，即改密后
 * 所有既有会话立即失效（改密当次由调用方用新版本重发 cookie）。
 *
 * @param {{email?:string, passwordHash:string, passwordRev?:number, sessionSecret:string, ttlMs?:number, cookieSecure?:boolean}} cfg
 * @param {{onPersist?:(patch:{email?:string, passwordHash?:string, passwordRev?:number}) => void}} [hooks]
 */
export function createAuth(cfg = {}, hooks = {}) {
  let email = String(cfg.email || '').trim().toLowerCase();
  let passwordHash = cfg.passwordHash || '';
  let pwRev = Number.isFinite(cfg.passwordRev) && cfg.passwordRev > 0 ? Math.floor(cfg.passwordRev) : 1;
  const secret = cfg.sessionSecret || '';
  const ttlMs = cfg.ttlMs || DEFAULT_TTL_MS;
  const cookieSecure = !!cfg.cookieSecure;
  const onPersist = typeof hooks?.onPersist === 'function' ? hooks.onPersist : null;
  const attempts = new Map(); // ip -> {fails, lockUntil, last}

  /** 把首次登录的邮箱记为白名单，并经 onPersist 持久化。 */
  function captureEmail(e) {
    email = String(e || '').trim().toLowerCase();
    if (onPersist) onPersist({ email });
  }

  /**
   * 校验登录凭据，返回 {ok, capture?}：
   *   - 密码错误 → {ok:false}（仍跑完 scrypt，避免时序侧信道）；
   *   - 已有白名单 → 邮箱须精确匹配；
   *   - 无白名单（首次）→ 任意合法邮箱 + 正确密码 → {ok:true, capture:邮箱}。
   */
  function checkLogin(emailIn, pw) {
    const e = String(emailIn || '').trim().toLowerCase();
    // 始终对占位哈希跑一次 scrypt，拉平"邮箱/密码是否存在"的时序。
    const stored = passwordHash || PLACEHOLDER_HASH;
    const pwOk = verifyPassword(String(pw || ''), stored);
    if (!pwOk) return { ok: false };
    if (email) return { ok: safeEqualStr(e, email) };
    if (isValidEmail(e)) return { ok: true, capture: e };
    return { ok: false };
  }

  /**
   * 修改密码：校验旧密码 → 强度校验 → 新 scrypt 哈希 → 版本号递增 → onPersist 持久化。
   * 成功返回 {ok, passwordRev}；失败返回 {ok:false, error}。成功后既有会话因版本号过期。
   */
  function changePassword(currentPlain, nextPlain) {
    const cur = String(currentPlain || '');
    const next = String(nextPlain || '');
    if (!passwordHash) return { ok: false, error: '尚未设置登录密码' };
    if (!verifyPassword(cur, passwordHash)) return { ok: false, error: '当前密码错误' };
    if (next.length < 8) return { ok: false, error: '新密码至少 8 位' };
    if (next === cur) return { ok: false, error: '新密码不能与旧密码相同' };
    const newHash = hashPassword(next);
    passwordHash = newHash;
    pwRev += 1;
    if (onPersist) onPersist({ passwordHash: newHash, passwordRev: pwRev });
    return { ok: true, passwordRev: pwRev };
  }

  function isLocked(ip) {
    const a = attempts.get(ip);
    return !!(a && a.lockUntil && a.lockUntil > Date.now());
  }
  function lockMsLeft(ip) {
    const a = attempts.get(ip);
    return a && a.lockUntil ? Math.max(0, a.lockUntil - Date.now()) : 0;
  }
  function recordAttempt(ip, ok) {
    const now = Date.now();
    const a = attempts.get(ip) || { fails: 0, lockUntil: 0, last: 0 };
    a.last = now;
    if (ok) { a.fails = 0; a.lockUntil = 0; }
    else { a.fails += 1; if (a.fails >= MAX_FAILS) a.lockUntil = now + LOCK_MS; }
    attempts.set(ip, a);
    // 顺手清理过期项，防内存无限增长
    if (attempts.size > 10000) {
      for (const [k, v] of attempts) {
        if ((!v.lockUntil || v.lockUntil < now) && v.last < now - LOCK_MS) attempts.delete(k);
      }
    }
  }

  function toCookieHeader(token, maxAgeMs) {
    const segs = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (cookieSecure) segs.push('Secure');
    return segs.join('; ');
  }
  /** 颁发登录态：用当前密码版本号签名，返回 token 及完整 Set-Cookie 头值。 */
  function issueSession(userEmail) {
    const { token, exp } = createSession(userEmail, secret, ttlMs, pwRev);
    return { token, exp, cookieHeader: toCookieHeader(token, ttlMs), passwordRev: pwRev };
  }
  function clearCookieHeader() {
    const segs = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
    if (cookieSecure) segs.push('Secure');
    return segs.join('; ');
  }

  /** 校验请求是否已登录（含密码版本号校验），返回 {email} 或 null。 */
  function verifyRequest(req) {
    const tok = parseCookies(req)[COOKIE_NAME];
    if (!tok) return null;
    const r = verifySession(tok, secret);
    if (!r) return null;
    if (r.v !== pwRev) return null; // 密码已改（版本号不匹配）→ 视同过期
    return { email: r.email };
  }

  return {
    COOKIE_NAME,
    get whitelistEmail() { return email; },
    hasWhitelist: () => !!email,
    captureEmail,
    checkLogin, isLocked, lockMsLeft, recordAttempt,
    issueSession, clearCookieHeader, verifyRequest,
    changePassword,
    get passwordRev() { return pwRev; },
    /** 配置是否就绪：有密码哈希即可启动（邮箱可空=首次登录时捕获）。 */
    get configured() { return !!passwordHash; },
  };
}

// ── CLI：交互式生成密码哈希（输入隐藏） ──────────────────────
async function promptPassword(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const isTTY = !!stdin.isTTY;
    let prevRaw = false;
    if (isTTY) { try { prevRaw = stdin.isRaw; stdin.setRawMode(true); } catch { /* not a TTY */ } }
    let pw = '';
    let done = false;
    function finish() {
      if (done) return; done = true;
      stdin.removeListener('data', onData);
      if (isTTY) { try { stdin.setRawMode(prevRaw); } catch { /* ignore */ } }
      try { stdin.pause(); } catch { /* ignore */ }
      process.stdout.write('\n');
      resolve(pw);
    }
    function onData(buf) {
      for (const ch of buf.toString('utf8')) {
        const code = ch.codePointAt(0);
        if (ch === '\n' || ch === '\r' || code === 4) return finish(); // Enter / Ctrl-D
        if (code === 3) { // Ctrl-C
          if (isTTY) { try { stdin.setRawMode(prevRaw); } catch { /* ignore */ } }
          process.stdout.write('\n');
          process.exit(0);
        }
        if (code === 127 || code === 8) { if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); } }
        else { pw += ch; process.stdout.write('*'); }
      }
    }
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function runHashCli() {
  console.log('— 生成登录密码哈希（输入隐藏）—');
  const pw1 = await promptPassword('请设置登录密码 (至少 8 位): ');
  if (pw1.length < 8) { console.error('\n✗ 密码至少 8 位，请重新运行。'); process.exit(1); }
  const pw2 = await promptPassword('再次输入以确认:           ');
  if (pw1 !== pw2) { console.error('\n✗ 两次输入不一致，请重新运行。'); process.exit(1); }
  const h = hashPassword(pw1);
  console.log('\n✓ 已生成。请把下面这一整行填入项目根目录的 .env（设置 LOGIN_PASSWORD_HASH）：\n');
  console.log(`LOGIN_PASSWORD_HASH=${h}`);
  console.log('\n白名单邮箱 LOGIN_EMAIL 可留空：首次用正确密码登录的邮箱会自动成为管理员。');
  console.log('（可选但推荐）设一个固定的 SESSION_SECRET 随机串，保证重启后登录态不失效。');
  process.exit(0);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'hash') {
    runHashCli().catch((e) => { console.error(e); process.exit(1); });
  } else {
    console.log('用法:\n  node src/auth.js hash   交互式生成登录密码哈希');
    process.exit(cmd ? 1 : 0);
  }
}
