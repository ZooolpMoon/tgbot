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
