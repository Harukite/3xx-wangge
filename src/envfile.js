// ─────────────────────────────────────────────────────────────
// .env 文件读写工具：按 KEY 增/改/删单行，供"交易所配置管理"等
// 需要把 UI 配置同步落盘到 .env 的场景复用（消除重复的字符串拼接）。
// 纯文本行操作，不解析值类型；调用方负责校验值的合法性。
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const ENV_FILE = path.join(ROOT, '.env');

function load() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
}
function save(content) {
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

/** 取某个 KEY 当前的值（不存在返回 null）。仅识别未注释的 KEY=... 行。 */
export function getEnvValue(key) {
  const m = load().match(new RegExp(`^\\s*${escapeRe(key)}\\s*=.*$`, 'm'));
  if (!m) return null;
  return m[0].slice(m[0].indexOf('=') + 1).replace(/\s+#.*$/, '').trim();
}

/**
 * 设置某个 KEY：已存在（含被注释的）则替换该行，否则追加一行。
 * value 为空时写成注释行 `# KEY=`（保留键名、置空，等价于未设置）。
 */
export function setEnvKey(key, value) {
  const v = value == null ? '' : String(value);
  const line = v === '' ? `# ${key}=` : `${key}=${v}`;
  let content = load();
  const regex = new RegExp(`^[ \\t]*#?[ \\t]*${escapeRe(key)}[ \\t]*=.*$`, 'm');
  if (regex.test(content)) content = content.replace(regex, line);
  else content = (content.trimEnd() ? content.trimEnd() + '\n' : '') + line + '\n';
  save(content);
}

/** 删除某个 KEY 的所有行（含被注释的）。 */
export function removeEnvKey(key) {
  const content = load().replace(
    new RegExp(`^[ \\t]*#?[ \\t]*${escapeRe(key)}[ \\t]*=.*\\r?\\n?`, 'gm'),
    '',
  );
  save(content);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
