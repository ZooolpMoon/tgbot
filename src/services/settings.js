// ==========================================
// 🗄️ 全局设置
// 这张表（沿用历史表名 scene_settings）按 scene_key 分行：
//   scene_key = 'global'      全局设置：feature.<key> 功能开关、task.<name> 任务设置、schema.version
//   scene_key = 具体场景键     v2.2.0 起的场景级覆盖（同一个键优先于全局）
// 因此本模块只读写 global 行，场景级覆盖请用 services/features.js。
// ==========================================

import { logError } from "../core/logger.js";

export const SETTINGS_SCOPE = "global";

/** 读取一条全局设置；不存在或解析失败返回 fallback */
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

/** 按前缀批量读取全局设置，返回 { name: value } */
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

/** 写入 / 覆盖一条全局设置 */
export async function setSetting(env, name, value) {
  if (!env.DB || !name) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_SCOPE, String(name), String(value)).run();
  return true;
}

/** 删除一条全局设置（删除后回退默认值） */
export async function deleteSetting(env, name) {
  if (!env.DB || !name) return false;
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
    .bind(SETTINGS_SCOPE, String(name)).run();
  return true;
}
