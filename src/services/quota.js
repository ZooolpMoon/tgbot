// ==========================================
// 📅 每日额度服务
// ==========================================

import { DEFAULTS } from "../config/constants.js";

export async function reserveDailyQuota(env, sceneKey, dateStr, maxDaily) {
  if (!env.DB || maxDaily === DEFAULTS.UNLIMITED) return true;

  const res = await env.DB.prepare(`
    INSERT INTO daily_stats (scene_key, date_str, count)
    VALUES (?, ?, 1)
    ON CONFLICT(scene_key, date_str)
    DO UPDATE SET count = daily_stats.count + 1
    WHERE daily_stats.count < ?
  `).bind(sceneKey, dateStr, maxDaily).run();

  return res.meta.changes > 0;
}

export async function refundDailyQuota(env, sceneKey, dateStr) {
  if (!env.DB || !sceneKey) return;
  await env.DB.prepare(
    "UPDATE daily_stats SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE scene_key = ? AND date_str = ?"
  ).bind(sceneKey, dateStr).run();
}

export async function getTodayCount(env, sceneKey, dateStr) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare(
    "SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?"
  ).bind(sceneKey, dateStr).first();
  return row ? Number(row.count) || 0 : 0;
}

export async function resetTodayCount(env, sceneKey, dateStr) {
  if (!env.DB) return;
  await env.DB.prepare(
    "UPDATE daily_stats SET count = 0 WHERE scene_key = ? AND date_str = ?"
  ).bind(sceneKey, dateStr).run();
}