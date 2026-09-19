// ==========================================
// 🧩 统一配置模型（v3.0.0）
//
// 以前每个模块各自实现「作用域链」，读法不一致，排查时经常搞不清
// 「我改的到底生不生效」：
//   • 功能开关：场景 → 全局
//   • 消息自动删除：群 → 全局
//   • 每日限额 / 冷却：只认 scene
// 现在统一走这里：**调用方给出作用域链（优先级从高到低），返回生效值 + 来源**。
// 存储仍然是 scene_settings（scene_key + name），所以不需要迁移；只是读法统一了。
//
// 约定：
//   • 作用域链的最后一层通常固定是 "global"（兜底）
//   • 返回值里的 source 就是命中那一层的 scene_key，面板可以直接告诉管理员「来源」
//   • 结构化配置（群规 / 默认处置等）仍放各自表里，这里只处理 key-value
// ==========================================

import { logError } from "../core/logger.js";

export const GLOBAL_SCOPE = "global";

/**
 * 构造作用域链（去重、去空、保证 global 在最后）。
 * @param {{sceneKey?:string, groupKey?:string}} [scopes]
 * @returns {string[]} 优先级从高到低
 */
export function buildScopeChain({ sceneKey = null, groupKey = null } = {}) {
  const chain = [];
  if (sceneKey && sceneKey !== GLOBAL_SCOPE) chain.push(String(sceneKey));
  if (groupKey && groupKey !== GLOBAL_SCOPE && !chain.includes(String(groupKey))) {
    chain.push(String(groupKey));
  }
  chain.push(GLOBAL_SCOPE);
  return chain;
}

/**
 * 批量解析某个前缀下的配置。
 * @param {object} env
 * @param {string[]} scopeChain 优先级从高到低
 * @param {string} prefix 键名前缀，例如 "feature." / "autodelete."
 * @returns {Promise<Map<string, {value:string, scope:string}>>} key = 去掉前缀后的名字
 */
export async function loadScopedSettings(env, scopeChain, prefix) {
  const result = new Map();
  if (!env?.DB) return result;

  const chain = (scopeChain || []).map(String);
  if (chain.length === 0) return result;

  let rows = [];
  try {
    const placeholders = chain.map(() => "?").join(", ");
    const stmt = env.DB.prepare(
      `SELECT scene_key, name, value FROM scene_settings
       WHERE scene_key IN (${placeholders}) AND name LIKE ?`
    ).bind(...chain, `${prefix}%`);
    rows = (await stmt.all()).results || [];
  } catch (e) {
    logError("读取配置失败：", e);
    return result;
  }

  // 按作用域链顺序覆盖：先命中的（更高优先级）留下，后面的不覆盖
  for (const scope of chain) {
    for (const row of rows) {
      if (String(row.scene_key) !== scope) continue;
      const name = String(row.name || "");
      if (!name.startsWith(prefix)) continue;
      const key = name.slice(prefix.length);
      if (result.has(key)) continue;
      result.set(key, { value: String(row.value), scope });
    }
  }

  return result;
}

/** 来源 → 面板文案：让管理员一眼看出「这个值是谁定的」 */
export function describeSource(scope, { sceneKey = null, groupKey = null } = {}) {
  if (!scope) return "内置默认";
  if (scope === GLOBAL_SCOPE) return "全局默认";
  if (groupKey && String(scope) === String(groupKey)) return "本群设置";
  if (sceneKey && String(scope) === String(sceneKey)) return "本场景设置";
  return String(scope);
}
