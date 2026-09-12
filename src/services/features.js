// ==========================================
// ⚙️ 功能开关
//
// 三级结构（v2.2.0）：
//   🌍 全局设置        scopeKey = "global"
//   👥 群聊场景        scopeKey = 该群的 sceneKey
//   💬 私聊场景        scopeKey = 该用户的 sceneKey
//
// 生效顺序：场景显式设置 → 全局显式设置 → 默认开启
// ==========================================

import { logError } from "../core/logger.js";

export const GLOBAL_SCOPE = "global";

export const FEATURES = [
  { key: "ai", label: "AI 对话", desc: "私聊 / 群聊里的 AI 回复" },
  { key: "kb", label: "知识库检索", desc: "AI 回答前先检索管理员上传的资料" },
  { key: "game", label: "游戏大厅", desc: "骰子、老虎机、硬币、转盘" },
  { key: "checkin", label: "每日签到", desc: "连续签到奖励" },
  { key: "shop", label: "积分商城", desc: "商品浏览与兑换" },
  { key: "redeem", label: "兑换码", desc: "用兑换码领积分" },
  { key: "tasks", label: "每日任务", desc: "完成任务领积分" }
];

const PREFIX = "feature.";
const FEATURE_KEYS = FEATURES.map((f) => f.key);

/** 是否是已知的功能开关键 */
export function isFeatureKey(key) {
  return FEATURE_KEYS.includes(key);
}

/** 开关键 → 中文名（未知键原样返回） */
export function featureLabel(key) {
  return FEATURES.find((f) => f.key === key)?.label || key;
}

/** 某个作用域里显式设置过的开关（不含继承） */
export async function getExplicitSettings(env, scopeKey) {
  const map = {};
  if (!env.DB || !scopeKey) return map;

  try {
    const { results } = await env.DB.prepare(
      "SELECT name, value FROM scene_settings WHERE scene_key = ?"
    ).bind(scopeKey).all();

    for (const row of results || []) {
      const name = String(row.name || "");
      if (!name.startsWith(PREFIX)) continue;
      const key = name.slice(PREFIX.length);
      if (isFeatureKey(key)) map[key] = String(row.value) !== "off";
    }
  } catch (e) {
    logError("读取功能开关失败：", e);
  }
  return map;
}

/**
 * 最终生效状态：默认开启 → 全局设置 → 场景覆盖。
 * @param {string|null} sceneKey 不传则只看全局
 */
export async function getFeatureMap(env, sceneKey = null) {
  const map = {};
  for (const f of FEATURES) map[f.key] = true;
  if (!env.DB) return map;

  const useScene = Boolean(sceneKey) && sceneKey !== GLOBAL_SCOPE;

  // 一次查询取出两层设置
  let rows = [];
  try {
    const stmt = useScene
      ? env.DB.prepare("SELECT scene_key, name, value FROM scene_settings WHERE scene_key IN (?, ?)").bind(GLOBAL_SCOPE, sceneKey)
      : env.DB.prepare("SELECT scene_key, name, value FROM scene_settings WHERE scene_key = ?").bind(GLOBAL_SCOPE);
    rows = (await stmt.all()).results || [];
  } catch (e) {
    logError("读取功能开关失败：", e);
    return map;
  }

  const apply = (scope) => {
    for (const row of rows) {
      if (String(row.scene_key) !== scope) continue;
      const name = String(row.name || "");
      if (!name.startsWith(PREFIX)) continue;
      const key = name.slice(PREFIX.length);
      if (isFeatureKey(key)) map[key] = String(row.value) !== "off";
    }
  };

  apply(GLOBAL_SCOPE);
  if (useScene) apply(sceneKey);
  return map;
}

/** 判断某个场景下某功能是否可用（未知开关一律视为可用） */
export async function isFeatureEnabled(env, sceneKey, feature) {
  if (!isFeatureKey(feature)) return true;
  const map = await getFeatureMap(env, sceneKey);
  return map[feature] !== false;
}

/** 设置开关；scopeKey 可以是 "global" 或某个场景的 sceneKey */
export async function setFeature(env, scopeKey, feature, enabled) {
  if (!env.DB || !isFeatureKey(feature) || !scopeKey) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(scopeKey, `${PREFIX}${feature}`, enabled ? "on" : "off").run();
  return true;
}

/** 清除某个作用域的全部覆盖（场景用：恢复跟随全局） */
export async function clearFeatureOverrides(env, scopeKey) {
  if (!env.DB || !scopeKey) return 0;
  const res = await env.DB.prepare(
    "DELETE FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
  ).bind(scopeKey, `${PREFIX}%`).run();
  return Number(res.meta.changes) || 0;
}

/** 清除单个开关的覆盖 */
export async function clearFeatureOverride(env, scopeKey, feature) {
  if (!env.DB || !isFeatureKey(feature) || !scopeKey) return false;
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
    .bind(scopeKey, `${PREFIX}${feature}`).run();
  return true;
}
