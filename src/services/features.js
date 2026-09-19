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
import { cacheClear, cacheGet, cacheSet } from "./cache.js";
import { buildScopeChain, loadScopedSettings } from "./config.js";

export const GLOBAL_SCOPE = "global";
/** 缓存命名空间与 TTL（写路径会主动清，TTL 只是兜底） */
const CACHE_NS = "features";
const CACHE_TTL_MS = 30 * 1000;

export const FEATURES = [
  { key: "ai", label: "AI 对话", desc: "私聊 / 群聊里的 AI 回复" },
  { key: "kb", label: "知识库检索", desc: "AI 回答前先检索管理员上传的资料" },
  { key: "guard", label: "群规执法", desc: "群里 @ 机器人下达封禁 / 踢出 / 禁言（需说明理由）" },
  { key: "game", label: "游戏大厅", desc: "骰子、老虎机、硬币、转盘" },
  { key: "checkin", label: "每日签到", desc: "连续签到奖励" },
  { key: "shop", label: "积分商城", desc: "商品浏览与兑换" },
  { key: "redeem", label: "兑换码", desc: "用兑换码领积分" },
  { key: "transfer", label: "积分转账", desc: "用户之间互相转积分" },
  { key: "lottery", label: "每日抽奖", desc: "免费抽奖与花积分抽奖" },
  { key: "ai_tools", label: "AI 工具调用", desc: "让 AI 能查积分 / 签到 / 排行榜 / 群规 / 知识库（只读）" },
  // v3.9.0：默认**关闭**。开启后机器人会主动在群里发消息、甚至限制新成员发言，
  // 属于「会打扰人」的功能，必须由管理员显式打开（见下面的 defaultEnabled）。
  { key: "welcome", label: "入群欢迎与验证", desc: "新成员入群时发欢迎语，可要求点按钮通过验证", defaultEnabled: false }
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
  const cacheKey = sceneKey || GLOBAL_SCOPE;
  const cached = cacheGet(CACHE_NS, cacheKey, env.DB);
  if (cached) return cached;

  const map = {};
  // 默认开启；显式标了 defaultEnabled: false 的开关默认关闭。
  // 「会主动打扰群成员」的功能（如入群欢迎）必须由管理员显式打开，
  // 否则升级一次就会往所有群发消息、限制新成员发言。
  for (const f of FEATURES) map[f.key] = f.defaultEnabled !== false;
  if (!env.DB) return map;

  // 统一走配置模型：场景 → 全局（缺少哪层就用下一层）
  const settings = await loadScopedSettings(env, buildScopeChain({ sceneKey }), PREFIX);
  for (const [key, item] of settings) {
    if (isFeatureKey(key)) map[key] = item.value !== "off";
  }

  return cacheSet(CACHE_NS, cacheKey, map, CACHE_TTL_MS, env.DB);
}

/** 每个开关当前生效值来自哪一层（面板显示「来源」用） */
export async function getFeatureSources(env, sceneKey = null) {
  const settings = await loadScopedSettings(env, buildScopeChain({ sceneKey }), PREFIX);
  const sources = {};
  for (const [key, item] of settings) sources[key] = item.scope;
  return sources;
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
  cacheClear(CACHE_NS);
  return true;
}

/** 清除某个作用域的全部覆盖（场景用：恢复跟随全局） */
export async function clearFeatureOverrides(env, scopeKey) {
  if (!env.DB || !scopeKey) return 0;
  const res = await env.DB.prepare(
    "DELETE FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
  ).bind(scopeKey, `${PREFIX}%`).run();
  cacheClear(CACHE_NS);
  return Number(res.meta.changes) || 0;
}

/** 清除单个开关的覆盖 */
export async function clearFeatureOverride(env, scopeKey, feature) {
  if (!env.DB || !isFeatureKey(feature) || !scopeKey) return false;
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
    .bind(scopeKey, `${PREFIX}${feature}`).run();
  cacheClear(CACHE_NS);
  return true;
}
