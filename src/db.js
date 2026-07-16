// ─────────────────────────────────────────────────────────────
// 本地 SQLite 持久化（better-sqlite3，纯本地文件，无外部服务）。
// 目前存储"交易所实盘配置"（凭据 + 模式 + 网络），与 .env 双写：
//   - 数据库：便于 UI 增删改查、列出已配置项；
//   - .env  ：程序实际启动时读取（getConfig）。
// 数据库文件默认 data/app.db，可用 DB_PATH 自定义；含私钥，勿提交（.gitignore 已排除）。
// ─────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DB_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DB_DIR, 'app.db');

let _db = null;

/** 打开（或复用）数据库连接，建表，开启 WAL。 */
export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS exchange_config (
      exchange   TEXT PRIMARY KEY,              -- 'de' | 'ex' | 'rs'
      mode       TEXT NOT NULL DEFAULT 'paper', -- 'paper' | 'live'
      network    TEXT NOT NULL DEFAULT 'mainnet',
      fields     TEXT NOT NULL DEFAULT '{}',    -- JSON: { ENV_KEY: value, ... }
      updated_at INTEGER NOT NULL
    );
  `);
  return _db;
}

const EXCHANGES = ['de', 'ex', 'rs'];

/** 取单个交易所配置（无则 null）。 */
export function getExchangeConfig(ex) {
  const row = getDb().prepare('SELECT * FROM exchange_config WHERE exchange = ?').get(ex);
  if (!row) return null;
  return { exchange: row.exchange, mode: row.mode, network: row.network, fields: safeParse(row.fields), updatedAt: row.updated_at };
}

/** 列出三个交易所配置（未配置的返回默认空壳）。 */
export function listExchangeConfigs() {
  return EXCHANGES.map((ex) => {
    const c = getExchangeConfig(ex);
    return c || { exchange: ex, mode: 'paper', network: 'mainnet', fields: {}, updatedAt: null };
  });
}

/** 新增或更新一个交易所配置。 */
export function upsertExchangeConfig(ex, { mode, network, fields }) {
  getDb().prepare(
    `INSERT INTO exchange_config (exchange, mode, network, fields, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(exchange) DO UPDATE SET mode=excluded.mode, network=excluded.network, fields=excluded.fields, updated_at=excluded.updated_at`,
  ).run(ex, mode, network, JSON.stringify(fields || {}), Date.now());
}

/** 删除一个交易所配置。 */
export function deleteExchangeConfig(ex) {
  getDb().prepare('DELETE FROM exchange_config WHERE exchange = ?').run(ex);
}

function safeParse(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}
