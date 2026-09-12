// ==========================================
// 🕒 时区与日期
// 所有「今天」都必须经过这里，保证签到、额度、任务与兑换码使用同一时区。
// ==========================================

/** 应用时区；未配置时回退 Asia/Shanghai */
export function getAppTimeZone(env) {
  const tz = env?.APP_TIMEZONE ? String(env.APP_TIMEZONE).trim() : "Asia/Shanghai";
  return tz || "Asia/Shanghai";
}

/** 取某一天在本应用时区下的日期键（YYYY-MM-DD） */
export function getDateKey(env, date = new Date()) {
  const timeZone = getAppTimeZone(env);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const v = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;
  return `${v.year}-${v.month}-${v.day}`;
}

/**
 * 日期键（YYYY-MM-DD）按天数平移，纯字符串运算，不受时区影响。
 * @param {string} dateKey 形如 2026-09-12
 * @param {number} deltaDays 正数向后、负数向前
 */
export function shiftDateKey(dateKey, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || "").trim());
  if (!m) return "";
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const shifted = new Date(base + Math.trunc(deltaDays) * 86400000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * 判断 a 是否是 b 的前一天（用于连续签到判定）。
 */
export function isPreviousDay(a, b) {
  return Boolean(a) && shiftDateKey(a, 1) === b;
}

/**
 * 把库里存的「UTC 时间」解析成 Date。
 *
 * 支持的输入（数据库与代码里都出现过的几种形态）：
 *   • SQLite 的 'YYYY-MM-DD HH:MM:SS'（CURRENT_TIMESTAMP / datetime('now') 都是 UTC）
 *   • ISO 8601，带 Z 或带时区偏移
 *   • 秒 / 毫秒时间戳（数字，或纯数字字符串）
 * 解析不了返回 null，调用方决定怎么兜底。
 */
function parseStoredTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // 秒级时间戳（约 1e9~1e10）与毫秒级（约 1e12+）用数量级区分
    const ms = Math.abs(value) > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseStoredTime(Number(raw));

  // 没有时区标记的（含 SQLite 的空格分隔格式）按 UTC 解析，否则会被当成本地时间
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const d = new Date(hasZone ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → 应用时区下的日期时间片段 */
function timeParts(env, date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: getAppTimeZone(env),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const v = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;
  // 部分运行时午夜会给出 24:00，统一归一成 00:00
  if (v.hour === "24") v.hour = "00";
  return v;
}

/**
 * 把库里存的 UTC 时间转成**应用时区**（默认北京时间 UTC+8）的可读文案。
 *
 * 为什么只做展示层转换：库里的 created_at / updated_at 全是 UTC，
 * 增量比较、10 分钟去重、到期判定也都按 UTC 做；只在「给人看」的时候换算，
 * 就不用担心改存储格式把历史数据和判定逻辑一起弄坏。
 *
 * @param {object} env
 * @param {string|number|Date|null|undefined} value 库里读出来的时间
 * @param {{seconds?:boolean}} [options] seconds = 是否显示到秒，默认 true
 * @returns {string} 'YYYY-MM-DD HH:MM[:SS]'；解析不了则原样返回，方便排查
 */
export function formatAppTime(env, value, { seconds = true } = {}) {
  const date = parseStoredTime(value);
  if (!date) return value === null || value === undefined ? "" : String(value);
  const v = timeParts(env, date);
  const hm = `${v.hour}:${v.minute}`;
  return seconds
    ? `${v.year}-${v.month}-${v.day} ${hm}:${v.second}`
    : `${v.year}-${v.month}-${v.day} ${hm}`;
}

/** 应用时区下的「现在」（'YYYY-MM-DD HH:MM:SS'，只用于临时展示，不要写库） */
export function nowAppTime(env, { seconds = true } = {}) {
  return formatAppTime(env, Date.now(), { seconds });
}
