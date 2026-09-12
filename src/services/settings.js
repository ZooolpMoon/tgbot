// ==========================================
// 🗄️ 全局设置
// v2.1.0 起功能开关只服务全局，这张表（沿用历史表名 scene_settings）
// 只存 scene_key = 'global' 的记录：
//   feature.<key>   功能开关
//   task.<name>     每日任务相关设置（如全勤奖）
// ==========================================

import { logError } from "../core/logger.js";

export const SETTINGS_SCOPE = "global";

export async function getSetting(env, name, fallback = null) {
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM scene_settings WHERE scene_key = ? AND name = ?"
    ).bind(SETTINGS_SCOPE, name).first();
    return row ? String(row.value) : fallback;
  } catch (e) {
    logError("读取全局设置失败：", e);
    return fallback;
  }
}

export async function getSettings(env, prefix = "") {
  const map = {};
  if (!env.DB) return map;
  try {
    const stmt = prefix
      ? env.DB.prepare("SELECT name, value FROM scene_settings WHERE scene_key = ? AND name LIKE ?").bind(SETTINGS_SCOPE, `${prefix}%`)
      : env.DB.prepare("SELECT name, value FROM scene_settings WHERE scene_key = ?").bind(SETTINGS_SCOPE);
    const { results } = await stmt.all();
    for (const row of results || []) map[String(row.name)] = String(row.value);
  } catch (e) {
    logError("读取全局设置失败：", e);
  }
  return map;
}

export async function setSetting(env, name, value) {
  if (!env.DB || !name) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_SCOPE, String(name), String(value)).run();
  return true;
}

export async function deleteSetting(env, name) {
  if (!env.DB || !name) return false;
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
    .bind(SETTINGS_SCOPE, String(name)).run();
  return true;
}
