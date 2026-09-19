// ==========================================
// 📅 每日额度服务
//
// 每个「场景」每天独立计数（私聊一个用户一个场景，群聊里每个成员各一个场景）。
// 计数用「条件 UPDATE」实现原子占位，避免并发请求把额度撑爆。
// ==========================================

import { DEFAULTS } from "../config/constants.js";

/**
 * 占用一次今日额度。
 * @returns {Promise<boolean>} 是否抢到额度（已达上限返回 false）
 */
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

/** 退还一次额度（AI 调用失败时回滚用），不会减到负数 */
export async function refundDailyQuota(env, sceneKey, dateStr) {
  if (!env.DB || !sceneKey) return;
  await env.DB.prepare(
    "UPDATE daily_stats SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE scene_key = ? AND date_str = ?"
  ).bind(sceneKey, dateStr).run();
}
