// ==========================================
// ⚙️ 功能开关（v2.1.0 起只服务全局）
//   AI 对话 / 游戏大厅 / 每日签到 / 积分商城 / 兑换码 / 每日任务
// 开启状态存在全局设置里：feature.<key> = on | off，缺省即开启。
// ==========================================

import { getSettings, setSetting, deleteSetting } from "./settings.js";

export const FEATURES = [
  { key: "ai", label: "AI 对话", desc: "私聊 / 群聊里的 AI 回复" },
  { key: "game", label: "游戏大厅", desc: "骰子、老虎机、硬币、转盘" },
  { key: "checkin", label: "每日签到", desc: "连续签到奖励" },
  { key: "shop", label: "积分商城", desc: "商品浏览与兑换" },
  { key: "redeem", label: "兑换码", desc: "用兑换码领积分" },
  { key: "tasks", label: "每日任务", desc: "完成任务领积分" }
];

const PREFIX = "feature.";
const FEATURE_KEYS = FEATURES.map((f) => f.key);

export function isFeatureKey(key) {
  return FEATURE_KEYS.includes(key);
}

export function featureLabel(key) {
  return FEATURES.find((f) => f.key === key)?.label || key;
}

/** 全局开关状态：缺省视为开启 */
export async function getFeatureMap(env) {
  const map = {};
  for (const f of FEATURES) map[f.key] = true;

  const settings = await getSettings(env, PREFIX);
  for (const [name, value] of Object.entries(settings)) {
    const key = name.slice(PREFIX.length);
    if (isFeatureKey(key)) map[key] = value !== "off";
  }
  return map;
}

export async function isFeatureEnabled(env, feature) {
  if (!isFeatureKey(feature)) return true;
  const map = await getFeatureMap(env);
  return map[feature] !== false;
}

export async function setFeature(env, feature, enabled) {
  if (!isFeatureKey(feature)) return false;
  return setSetting(env, `${PREFIX}${feature}`, enabled ? "on" : "off");
}

/** 清除设置，恢复默认开启 */
export async function resetFeature(env, feature) {
  if (!isFeatureKey(feature)) return false;
  return deleteSetting(env, `${PREFIX}${feature}`);
}
