// ==========================================
// 🕒 时区与日期
// ==========================================

export function getAppTimeZone(env) {
  const tz = env?.APP_TIMEZONE ? String(env.APP_TIMEZONE).trim() : "Asia/Shanghai";
  return tz || "Asia/Shanghai";
}

export function getDateKey(env) {
  const timeZone = getAppTimeZone(env);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const v = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;
  return `${v.year}-${v.month}-${v.day}`;
}