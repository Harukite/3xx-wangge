// Unit tests for the auth core (src/auth.js) and the rate limiter (src/ratelimit.js).
// These cover the security-critical paths added for: dynamic whitelist capture,
// password change (with session-version invalidation), and DDoS rate limiting.
// Run with: npm test   (the test script runs grid.test.js then auth.test.js)
import assert from 'node:assert/strict';
import { createLimiter } from '../src/ratelimit.js';
import { createAuth, hashPassword, createSession, verifySession, COOKIE_NAME } from '../src/auth.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
}

// 预置一个密码哈希，避免每个用例都跑一次 hashPassword
const KNOWN_HASH = hashPassword('hunter2pw');
const SECRET = 'test-session-secret';

// ── ratelimit.js ───────────────────────────────────────────────────────────
console.log('ratelimit.js');

test('createLimiter: 窗口内允许 max 次，超出拒绝', () => {
  let t = 1000;
  const lim = createLimiter({ windowMs: 1000, max: 3, now: () => t });
  assert.equal(lim.check('a').allowed, true);  // 1
  assert.equal(lim.check('a').allowed, true);  // 2
  assert.equal(lim.check('a').allowed, true);  // 3
  const over = lim.check('a');                  // 4 → 拒
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfterMs > 0);
});

test('createLimiter: 不同 key 各自独立计数', () => {
  let t = 0;
  const lim = createLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(lim.check('a').allowed, true);
  assert.equal(lim.check('a').allowed, false);
  assert.equal(lim.check('b').allowed, true); // 另一个 key，独立桶
});

test('createLimiter: 窗口过期后重置', () => {
  let t = 0;
  const lim = createLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(lim.check('a').allowed, true);
  assert.equal(lim.check('a').allowed, true);
  assert.equal(lim.check('a').allowed, false);
  t = 1001; // 进入下一窗口
  assert.equal(lim.check('a').allowed, true);
});

test('createLimiter: reset 清空计数', () => {
  let t = 0;
  const lim = createLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(lim.check('a').allowed, true);
  assert.equal(lim.check('a').allowed, false);
  lim.reset('a');
  assert.equal(lim.check('a').allowed, true);
});

test('createLimiter: 非正参数应抛错', () => {
  assert.throws(() => createLimiter({ windowMs: 0, max: 1 }));
  assert.throws(() => createLimiter({ windowMs: 1000, max: 0 }));
});

// ── auth.js ────────────────────────────────────────────────────────────────
console.log('auth.js');

test('configured: 只要有密码哈希即就绪（邮箱可空）', () => {
  assert.equal(createAuth({ sessionSecret: SECRET }).configured, false);
  assert.equal(createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET }).configured, true);
});

test('checkLogin: 已有白名单 + 正确密码 → ok，无 capture', () => {
  const a = createAuth({ email: 'admin@x.com', passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  const r = a.checkLogin('admin@x.com', 'hunter2pw');
  assert.equal(r.ok, true);
  assert.equal(r.capture, undefined);
});

test('checkLogin: 密码错误 → 失败', () => {
  const a = createAuth({ email: 'admin@x.com', passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.checkLogin('admin@x.com', 'wrongpw').ok, false);
});

test('checkLogin: 邮箱不匹配白名单 → 失败', () => {
  const a = createAuth({ email: 'admin@x.com', passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.checkLogin('other@x.com', 'hunter2pw').ok, false);
});

test('checkLogin: 无白名单 + 合法邮箱 + 正确密码 → capture', () => {
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.hasWhitelist(), false);
  const r = a.checkLogin('first@x.com', 'hunter2pw');
  assert.equal(r.ok, true);
  assert.equal(r.capture, 'first@x.com');
});

test('checkLogin: 无白名单 + 非法邮箱 → 失败', () => {
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.checkLogin('not-an-email', 'hunter2pw').ok, false);
});

test('captureEmail: 记下白名单（归一小写）并经 onPersist 持久化', () => {
  let persisted = null;
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET }, { onPersist: (p) => persisted = p });
  a.captureEmail('Boss@X.com');
  assert.equal(a.hasWhitelist(), true);
  assert.equal(a.whitelistEmail, 'boss@x.com');
  assert.deepEqual(persisted, { email: 'boss@x.com' });
});

test('changePassword: 旧密码错误 → 拒', () => {
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.changePassword('wrong', 'newpass12').ok, false);
});

test('changePassword: 新密码不足 8 位 → 拒', () => {
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.changePassword('hunter2pw', 'short').ok, false);
});

test('changePassword: 新旧相同 → 拒', () => {
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET });
  assert.equal(a.changePassword('hunter2pw', 'hunter2pw').ok, false);
});

test('changePassword: 成功 → 版本号递增 + 旧会话失效 + 持久化 + 新密码可登', () => {
  const persisted = [];
  const a = createAuth({ passwordHash: KNOWN_HASH, sessionSecret: SECRET }, { onPersist: (p) => persisted.push(p) });
  const beforeRev = a.passwordRev;
  // 颁发一个 session（携带当前版本号）
  const sess = a.issueSession('admin@x.com');
  const req = { headers: { cookie: `${COOKIE_NAME}=${sess.token}` } };
  assert.ok(a.verifyRequest(req), '改密前 session 应有效');
  // 改密
  const r = a.changePassword('hunter2pw', 'newpass123');
  assert.equal(r.ok, true);
  assert.equal(r.passwordRev, beforeRev + 1);
  // 旧 session 因版本号不匹配而失效
  assert.equal(a.verifyRequest(req), null, '改密后旧 session 应失效');
  // 新密码可登录
  assert.equal(a.checkLogin('admin@x.com', 'newpass123').ok, true);
  // 旧密码不再有效
  assert.equal(a.checkLogin('admin@x.com', 'hunter2pw').ok, false);
  // 持久化包含新哈希与版本号
  assert.ok(persisted.some((p) => p.passwordRev === r.passwordRev && typeof p.passwordHash === 'string'));
});

test('session: 版本号 v 写入并回读 payload', () => {
  const { token } = createSession('u@x.com', SECRET, 60000, 7);
  const v = verifySession(token, SECRET);
  assert.equal(v.v, 7);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
