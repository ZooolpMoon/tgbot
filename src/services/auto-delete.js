// ==========================================
// 🗑️ 消息自动删除设置
//
// 群聊里机器人自己发的消息，可以按「消息类型」分别设置保留时长：
//   0      = 不删除（一直保留）
//   N > 0  = N 秒后自动删除
//
// 生效顺序：本场景设置 → 全局设置 → 内置默认值。
// 存放位置沿用 scene_settings：
//   scene_key = 'global'     全局默认
//   scene_key = 具体场景键    该场景的覆盖（群聊 / 私聊各自独立）
//   name      = 'autodelete.<kind>'，value = 秒数
// 私聊消息不受影响，只作用于群聊（与 telegram/auto-delete.js 的约定一致）。
// ==========================================

import { RULES } from "../config/constants.js";
import { logError } from "../core/logger.js";

export const AUTO_DELETE_PREFIX = "autodelete.";
export const AUTO_DELETE_GLOBAL_SCOPE = "global";
/** 上限一天，避免误填出现「删不掉」的错觉 */
export const AUTO_DELETE_MAX_SEC = 86400;

/**
 * 可选的消息类型。
 * defaultSec 必须与「改造前的既有行为」一致：
 *   指令类回执 5 秒自动删除；卡片 / 公告 / AI 回复保持不删。
 */
export const AUTO_DELETE_KINDS = [
  {
    key: "cmd", label: "指令回执", icon: "⚙️", defaultSec: 5,
    desc: "指令的执行结果、用法提示与错误提示"
  },
  {
    key: "guard", label: "执法回执", icon: "🛡️", defaultSec: 5,
    desc: "封禁 / 踢出 / 禁言这类处置的结果提示"
  },
  {
    key: "card", label: "确认卡片", icon: "🖲️", defaultSec: 0,
    desc: "带按钮的确认 / 申诉卡片（需要留时间点击）"
  },
  {
    key: "ai", label: "AI 回复", icon: "🤖", defaultSec: 0,
    desc: "群聊里 AI 的回答（默认保留，便于回看）"
  },
  {
    key: "notice", label: "系统通知", icon: "📢", defaultSec: 0,
    desc: "处置公告、到期提醒与每日概况"
  }
];

/** 面板里可选的时长（秒）；0 = 不删除 */
export const AUTO_DELETE_PRESETS = [0, 5, 10, 30, 60, 300, 1800];

const KIND_MAP = new Map(AUTO_DELETE_KINDS.map((item) => [item.key, item]));

/**
 * 归一化作用域键：群聊按「群」共享设置，私聊按用户。
 * 场景键 `group:<群ID>:user:<用户ID>` 会收敛成 `group:<群ID>`——
 * 否则每个群成员一份设置，管理员改了别人看到的还是旧值。
 */
export function resolveAutoDeleteScope(scopeKey) {
  const key = String(scopeKey || "").trim();
  if (!key) return null;
  const matched = /^group:(-?\d+)/.exec(key);
  return matched ? `group:${matched[1]}` : key;
}

/** 是不是已知的消息类型 */
export function isAutoDeleteKind(key) {
  return KIND_MAP.has(String(key || ""));
}

/** 取类型定义（未知类型返回 null） */
export function autoDeleteKind(key) {
  return KIND_MAP.get(String(key || "")) || null;
}

/** 类型 → 中文名（未知类型原样返回） */
export function autoDeleteLabel(key) {
  const item = KIND_MAP.get(String(key || ""));
  return item ? `${item.icon} ${item.label}` : String(key || "");
}

/** 内置默认时长（秒）；未知类型回落到 RULES.AUTO_DELETE_MS */
export function defaultAutoDeleteSec(kind) {
  const item = KIND_MAP.get(String(kind || ""));
  if (item) return item.defaultSec;
  const ms = Number(RULES.AUTO_DELETE_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/** 解析存库的秒数：非法值返回 null（视为「没有设置」） */
export function parseAutoDeleteValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(AUTO_DELETE_MAX_SEC, n);
}

/** 秒数 → 面板文案 */
export function formatAutoDeleteDelay(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "不删除";
  if (n < 60) return `${Number.isInteger(n) ? n : n.toFixed(1)} 秒`;
  if (n % 3600 === 0) return `${n / 3600} 小时`;
  if (n % 60 === 0) return `${n / 60} 分钟`;
  return `${Math.floor(n / 60)} 分 ${Math.round(n % 60)} 秒`;
}

/** 某个作用域显式设置过的类型 → 秒数（不含默认值） */
export async function getExplicitAutoDelete(env, scopeKey) {
  const map = {};
  const scope = resolveAutoDeleteScope(scopeKey);
  if (!env?.DB || !scope) return map;
  try {
    const { results } = await env.DB.prepare(
      "SELECT name, value FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
    ).bind(scope, `${AUTO_DELETE_PREFIX}%`).all();
    for (const row of results || []) {
      const key = String(row.name || "").slice(AUTO_DELETE_PREFIX.length);
      if (!isAutoDeleteKind(key)) continue;
      const sec = parseAutoDeleteValue(row.value);
      if (sec !== null) map[key] = sec;
    }
  } catch (e) {
    logError("读取自动删除设置失败：", e);
  }
  return map;
}

/**
 * 最终生效的「类型 → 秒数」。
 * @param {string|null} sceneKey 不传或传 global 时只算全局默认
 */
export async function getAutoDeleteMap(env, sceneKey = null) {
  const map = {};
  for (const item of AUTO_DELETE_KINDS) map[item.key] = item.defaultSec;
  if (!env?.DB) return map;

  const scope = resolveAutoDeleteScope(sceneKey);
  const useScene = Boolean(scope) && scope !== AUTO_DELETE_GLOBAL_SCOPE;

  let rows = [];
  try {
    const stmt = useScene
      ? env.DB.prepare(
        "SELECT scene_key, name, value FROM scene_settings WHERE scene_key IN (?, ?) AND name LIKE ?"
      ).bind(AUTO_DELETE_GLOBAL_SCOPE, scope, `${AUTO_DELETE_PREFIX}%`)
      : env.DB.prepare(
        "SELECT scene_key, name, value FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
      ).bind(AUTO_DELETE_GLOBAL_SCOPE, `${AUTO_DELETE_PREFIX}%`);
    rows = (await stmt.all()).results || [];
  } catch (e) {
    logError("读取自动删除设置失败：", e);
    return map;
  }

  const apply = (scope) => {
    for (const row of rows) {
      if (String(row.scene_key) !== scope) continue;
      const key = String(row.name || "").slice(AUTO_DELETE_PREFIX.length);
      if (!isAutoDeleteKind(key)) continue;
      const sec = parseAutoDeleteValue(row.value);
      if (sec !== null) map[key] = sec;
    }
  };

  apply(AUTO_DELETE_GLOBAL_SCOPE);
  if (useScene) apply(scope);
  return map;
}

/** 某个场景下某类消息的保留秒数（0 = 不删除） */
export async function getAutoDeleteSeconds(env, sceneKey, kind) {
  const map = await getAutoDeleteMap(env, sceneKey);
  if (Object.prototype.hasOwnProperty.call(map, kind)) return map[kind];
  return defaultAutoDeleteSec(kind);
}

/**
 * 写入设置。
 * @param {string} scopeKey 'global' 或某个场景键
 * @param {string} kind 消息类型
 * @param {number} seconds 秒数，0 = 不删除
 */
export async function setAutoDeleteSeconds(env, scopeKey, kind, seconds) {
  const scope = resolveAutoDeleteScope(scopeKey);
  if (!env?.DB || !scope || !isAutoDeleteKind(kind)) return false;
  const sec = parseAutoDeleteValue(seconds);
  if (sec === null) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(scope, `${AUTO_DELETE_PREFIX}${kind}`, String(sec)).run();
  return true;
}

/** 清除某个作用域的覆盖（kind 省略时清空该作用域全部类型） */
export async function clearAutoDeleteOverride(env, scopeKey, kind = null) {
  const scope = resolveAutoDeleteScope(scopeKey);
  if (!env?.DB || !scope) return false;
  if (kind && !isAutoDeleteKind(kind)) return false;
  if (kind) {
    await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
      .bind(scope, `${AUTO_DELETE_PREFIX}${kind}`).run();
    return true;
  }
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name LIKE ?")
    .bind(scope, `${AUTO_DELETE_PREFIX}%`).run();
  return true;
}
