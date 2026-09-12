// ==========================================
// ⚙️ 功能开关
// 作用域：
//   "global"     全局默认（管理控制台 → 🧩 功能开关）
//   <sceneKey>   单场景覆盖（场景编辑 → 🧩 本场景功能）
// 生效顺序：场景显式设置 → 全局显式设置 → 默认开启
// ==========================================

export const GLOBAL_SCOPE = "global";

export const FEATURES = [
  { key: "ai", label: "AI 对话", desc: "私聊 / 群聊里的 AI 回复" },
  { key: "game", label: "游戏大厅", desc: "骰子、老虎机、硬币、转盘" },
  { key: "checkin", label: "每日签到", desc: "连续签到奖励" },
  { key: "shop", label: "积分商城", desc: "商品浏览与兑换" },
  { key: "redeem", label: "兑换码", desc: "用兑换码领积分" },
  { key: "tasks", label: "每日任务", desc: "完成任务领积分" }
];

const FEATURE_KEYS = FEATURES.map((f) => f.key);
const PREFIX = "feature.";

export function isFeatureKey(key) {
  return FEATURE_KEYS.includes(key);
}

export function featureLabel(key) {
  return FEATURES.find((f) => f.key === key)?.label || key;
}

/** 读取某个作用域里显式设置过的开关（不含继承） */
export async function getExplicitSettings(env, scopeKey) {
  const map = {};
  if (!env.DB || !scopeKey) return map;

  const { results } = await env.DB.prepare(
    "SELECT name, value FROM scene_settings WHERE scene_key = ?"
  ).bind(scopeKey).all();

  for (const row of results || []) {
    const name = String(row.name || "");
    if (!name.startsWith(PREFIX)) continue;
    const key = name.slice(PREFIX.length);
    if (isFeatureKey(key)) map[key] = String(row.value) !== "off";
  }
  return map;
}

/**
 * 一次查询取出「场景 + 全局」两层设置，算出最终生效状态。
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getFeatureMap(env, sceneKey = null) {
  const map = {};
  for (const f of FEATURES) map[f.key] = true; // 默认开启
  if (!env.DB) return map;

  const scopes = sceneKey && sceneKey !== GLOBAL_SCOPE ? [sceneKey, GLOBAL_SCOPE] : [GLOBAL_SCOPE];
  const { results } = await env.DB.prepare(
    "SELECT scene_key, name, value FROM scene_settings WHERE scene_key IN (?,?)"
  ).bind(scopes[0], scopes[1] || GLOBAL_SCOPE).all();

  // 先应用全局，再用场景覆盖
  for (const row of results || []) {
    const name = String(row.name || "");
    if (!name.startsWith(PREFIX)) continue;
    const key = name.slice(PREFIX.length);
    if (!isFeatureKey(key)) continue;
    if (String(row.scene_key) === GLOBAL_SCOPE) map[key] = String(row.value) !== "off";
  }
  if (sceneKey && sceneKey !== GLOBAL_SCOPE) {
    for (const row of results || []) {
      const name = String(row.name || "");
      if (!name.startsWith(PREFIX)) continue;
      const key = name.slice(PREFIX.length);
      if (!isFeatureKey(key)) continue;
      if (String(row.scene_key) === sceneKey) map[key] = String(row.value) !== "off";
    }
  }
  return map;
}

export async function isFeatureEnabled(env, sceneKey, feature) {
  if (!isFeatureKey(feature)) return true;
  const map = await getFeatureMap(env, sceneKey);
  return map[feature] !== false;
}

/** 设置开关（scopeKey = "global" 或某个 sceneKey） */
export async function setFeature(env, scopeKey, feature, enabled) {
  if (!env.DB || !isFeatureKey(feature) || !scopeKey) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(scopeKey, `${PREFIX}${feature}`, enabled ? "on" : "off").run();
  return true;
}

/** 清除场景级覆盖，恢复「跟随全局」 */
export async function clearFeatureOverride(env, scopeKey, feature) {
  if (!env.DB || !isFeatureKey(feature) || !scopeKey) return false;
  await env.DB.prepare(
    "DELETE FROM scene_settings WHERE scene_key = ? AND name = ?"
  ).bind(scopeKey, `${PREFIX}${feature}`).run();
  return true;
}
