// Lightweight crash-safe state persistence.
//
// A grid bot holds non-trivial in-memory state: its config, cumulative stats
// (volume / completed rungs / theoretical profit) and the starting balance used
// for return%. If the process restarts, all of that is lost while the REAL
// resting orders remain on the exchange — a dangerous "half-known grid".
//
// This module persists a small snapshot per exchange inside data/, alongside the
// SQLite database. Deployments already retain that directory as a volume, so a
// new container can restore the prior grid instead of losing it with /app.
//
// It does not include credential fields; only grid config and bounded runtime history.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const STATE_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(STATE_DIR, 'grid-state.json');
const LEGACY_STATE_FILE = path.join(ROOT, '.state.json');
const LEGACY_MIGRATION_MARKER = path.join(STATE_DIR, '.legacy-state-migrated');
const WARN_INTERVAL_MS = 60000;
const RETRY_MAX_MS = 30000;

let cache = null;
let saveTimer = null;
let lastWarnAt = 0;
let dirty = false;
let lastError = null;
let lastSuccessAt = null;
let retryMs = 1000;

function warn(action, error) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.error(`[状态持久化] ${action}失败（${STATE_FILE}）：${error?.message || error}`);
}

function readFile(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快照根节点必须是对象');
  return value;
}

function unreadableState(file, error) {
  const reason = error?.message || error;
  return new Error(`无法读取网格状态文件 ${file}（${reason}）。为防止遗留挂单无人管理，程序已中止启动；请修复文件/卷权限或先核对交易所挂单和仓位。`);
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(e?.code)) throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeFile(state = cache) {
  const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, STATE_FILE); // same-directory atomic replace
    fsyncDirectory(STATE_DIR);
    dirty = false;
    lastError = null;
    lastSuccessAt = Date.now();
    retryMs = 1000;
    return true;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    dirty = true;
    lastError = e?.message || String(e);
    warn('写入', e);
    return false;
  }
}

function assertStateDirWritable() {
  const probe = path.join(STATE_DIR, `.write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
  } catch (e) {
    try { fs.unlinkSync(probe); } catch { /* best effort cleanup */ }
    throw new Error(`无法写入网格状态目录 ${STATE_DIR}（${e?.message || e}）。程序已中止启动；请确认 /app/data 持久卷已挂载且 node 用户有写权限。`);
  }
}

function retireLegacyFile() {
  let markerError = null;
  let markerFd;
  try {
    markerFd = fs.openSync(LEGACY_MIGRATION_MARKER, 'w');
    fs.writeFileSync(markerFd, String(Date.now()), 'utf8');
    fs.fsyncSync(markerFd);
    fs.closeSync(markerFd); markerFd = undefined;
    fsyncDirectory(STATE_DIR);
  } catch (e) {
    if (markerFd !== undefined) { try { fs.closeSync(markerFd); } catch { /* ignore */ } }
    markerError = e;
  }
  let archiveError = null;
  try {
    const backup = `${LEGACY_STATE_FILE}.bak-migrated-${Date.now()}`;
    fs.renameSync(LEGACY_STATE_FILE, backup);
    fsyncDirectory(ROOT);
  } catch (e) {
    archiveError = e;
  }
  if (markerError && archiveError) {
    warn('退休旧快照', new Error(`迁移标记与归档均失败；${markerError.message}；${archiveError.message}`));
    return false;
  } else if (markerError) warn('标记旧快照迁移', markerError);
  else if (archiveError) warn('归档旧快照', archiveError);
  return true;
}

function scheduleWrite(delayMs) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty || writeFile()) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    scheduleWrite(delay);
  }, delayMs);
  saveTimer.unref?.();
}

/** Read the whole state file once (cached), migrating the legacy root file. */
export function loadState() {
  if (cache) return cache;
  let state;
  try {
    state = readFile(STATE_FILE);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      warn('读取', e);
      throw unreadableState(STATE_FILE, e);
    }
  }
  if (state) {
    // Verify the exact atomic-replace + fsync path before allowing any strategy
    // to resume; a directory probe alone misses a single-file bind mount (EBUSY).
    cache = state;
    dirty = true;
    if (!writeFile(state)) {
      cache = null;
      throw new Error(`网格状态文件可读但无法安全覆写 ${STATE_FILE}，程序已中止启动；请检查持久卷挂载、权限和可用空间。`);
    }
    if (fs.existsSync(LEGACY_STATE_FILE) && !fs.existsSync(LEGACY_MIGRATION_MARKER) && !retireLegacyFile()) {
      cache = null;
      throw new Error('新旧网格快照同时存在，但旧快照无法安全退休，程序已中止启动。');
    }
    return cache;
  }
  assertStateDirWritable();
  if (fs.existsSync(LEGACY_MIGRATION_MARKER)) {
    throw new Error(`未找到 ${STATE_FILE}，但检测到旧快照迁移标记。为防止遗留挂单无人管理或过期网格复活，程序已中止启动；请先核对交易所挂单和仓位，再按文档执行显式重置。`);
  }
  try {
    state = readFile(LEGACY_STATE_FILE);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      warn('读取旧快照', e);
      throw unreadableState(LEGACY_STATE_FILE, e);
    }
    cache = {};
    return cache;
  }
  if (!writeFile(state)) {
    throw new Error(`旧网格快照无法迁入 ${STATE_FILE}，程序已中止启动；请确认 /app/data 持久卷可写。`);
  }
  if (!retireLegacyFile()) throw new Error('旧网格快照已迁入新位置，但旧文件无法安全退休，程序已中止启动。');
  cache = state;
  console.log(`[状态持久化] 已迁移旧快照到 ${STATE_FILE}`);
  return cache;
}

/** Get a single bot's snapshot (e.g. key 'de'). */
export function loadSnapshot(key) {
  return loadState()[key] || null;
}

/** Persist one bot's snapshot under `key`, debounced to avoid thrashing disk. */
export function saveSnapshot(key, snapshot, { immediate = false } = {}) {
  const state = loadState();
  state[key] = snapshot;
  cache = state;
  dirty = true;
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!writeFile()) scheduleWrite(retryMs);
    return !dirty;
  }
  scheduleWrite(500);
  return true;
}

/** 立即把缓存同步落盘（用于优雅关闭：防抖 timer 是 unref，进程退出时不会触发）。 */
export function flushNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!cache || !dirty) return true;
  const ok = writeFile();
  if (!ok) scheduleWrite(retryMs);
  return ok;
}

export function getPersistenceHealth() {
  return {
    ok: lastError == null,
    dirty,
    lastError,
    lastSuccessAt,
    stateFile: STATE_FILE,
  };
}
