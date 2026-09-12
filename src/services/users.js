// ==========================================
// 👤 用户/场景服务
// ==========================================

import { DEFAULTS } from "../config/constants.js";

/**
 * 解析「每日额度」字段。
 * 数据库里可能是 NULL / 空串 / 非法值，统一收敛为：-1 = 不限，其余为 >= 0 的整数。
 * @param {unknown} rawValue user_scenes.max_daily
 */
export function parseMaxDaily(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return DEFAULTS.MAX_DAILY;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return DEFAULTS.MAX_DAILY;
  if (n === DEFAULTS.UNLIMITED) return DEFAULTS.UNLIMITED;
  return Math.max(0, Math.floor(n));
}

/**
 * 解析「发送冷却秒数」字段，非法值回退默认，最小 0。
 * @param {unknown} rawValue user_scenes.rate_limit_sec
 */
export function parseRateLimit(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return DEFAULTS.RATE_LIMIT_SEC;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return DEFAULTS.RATE_LIMIT_SEC;
  return Math.max(0, Math.floor(n));
}

/**
 * 写入 / 更新用户与场景信息。
 * users 表存「跨场景共享」的数据（积分、封禁状态），user_scenes 存场景级配置。
 */
export async function upsertUserInfo(env, uctx) {
  if (!env.DB || !uctx) return;
  const { userKey, userId, username, firstName, sceneKey, chatId, chatType } = uctx;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO users (user_key, user_id, username, first_name, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_key) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        updated_at = CURRENT_TIMESTAMP
    `).bind(userKey, userId, username || "无用户名", firstName || "未命名"),

    env.DB.prepare(`
      INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scene_key) DO UPDATE SET
        user_key = EXCLUDED.user_key,
        chat_id = EXCLUDED.chat_id,
        chat_type = EXCLUDED.chat_type,
        user_id = EXCLUDED.user_id,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        updated_at = CURRENT_TIMESTAMP
    `).bind(sceneKey, userKey, chatId, chatType, userId, username || "无用户名", firstName || "未命名")
  ]);
}

/**
 * 保存场景配置（语言 / 自定义 prompt / 每日额度 / 冷却 / 最后发言时间）。
 * 注意：max_daily、rate_limit_sec、last_msg_time 用 COALESCE 保留旧值，
 * 避免只改语言时把管理员设置好的额度覆盖回默认值。
 */
export async function saveSceneConfig(env, uctx, config) {
  if (!env.DB || !uctx) return;
  const { userKey, sceneKey, chatId, chatType, userId, username, firstName } = uctx;

  await env.DB.prepare(`
    INSERT INTO user_scenes (
      scene_key, user_key, chat_id, chat_type, user_id, username, first_name,
      lang, custom_prompt, max_daily, rate_limit_sec, last_msg_time, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key) DO UPDATE SET
      user_key = EXCLUDED.user_key,
      chat_id = EXCLUDED.chat_id,
      chat_type = EXCLUDED.chat_type,
      user_id = EXCLUDED.user_id,
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      lang = EXCLUDED.lang,
      custom_prompt = EXCLUDED.custom_prompt,
      max_daily = COALESCE(user_scenes.max_daily, EXCLUDED.max_daily),
      rate_limit_sec = COALESCE(user_scenes.rate_limit_sec, EXCLUDED.rate_limit_sec),
      last_msg_time = COALESCE(user_scenes.last_msg_time, EXCLUDED.last_msg_time),
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    sceneKey, userKey, chatId, chatType, userId,
    username || "无用户名", firstName || "未命名",
    config.lang || DEFAULTS.LANG,
    config.customPrompt || "",
    config.maxDaily ?? DEFAULTS.MAX_DAILY,
    config.rateLimitSec ?? DEFAULTS.RATE_LIMIT_SEC,
    config.lastMsgTime ?? 0
  ).run();
}

/**
 * 读取用户全局积分。
 * 没有数据库或用户不存在时返回默认初始积分，保证调用方拿到的永远是合法数字。
 */
export async function getUserPoints(env, userKey) {
  if (!env.DB) return DEFAULTS.POINTS;
  const u = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(userKey).first();
  return u && Number.isFinite(Number(u.points)) ? Math.max(0, Math.floor(Number(u.points))) : DEFAULTS.POINTS;
}

/**
 * 一次性加载「用户全局数据 + 场景配置」，供消息处理链路使用。
 * 任何字段非法都会回退到默认值，避免把脏数据带进业务逻辑。
 */
export async function loadUserConfig(env, userKey, sceneKey) {
  const config = {
    lang: DEFAULTS.LANG,
    points: DEFAULTS.POINTS,
    blocked: false,
    customPrompt: "",
    maxDaily: DEFAULTS.MAX_DAILY,
    rateLimitSec: DEFAULTS.RATE_LIMIT_SEC,
    lastMsgTime: 0
  };

  if (!env.DB) return config;

  const [u, s] = await Promise.all([
    env.DB.prepare("SELECT points, blocked FROM users WHERE user_key = ?").bind(userKey).first(),
    env.DB.prepare(
      "SELECT lang, custom_prompt, max_daily, rate_limit_sec, last_msg_time FROM user_scenes WHERE scene_key = ?"
    ).bind(sceneKey).first()
  ]);

  if (u) {
    const p = Number(u.points);
    config.points = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : DEFAULTS.POINTS;
    config.blocked = Number(u.blocked) === 1;
  }

  if (s) {
    config.lang = s.lang || DEFAULTS.LANG;
    config.customPrompt = s.custom_prompt || "";

    config.maxDaily = parseMaxDaily(s.max_daily);
    config.rateLimitSec = parseRateLimit(s.rate_limit_sec);

    const plt = Number(s.last_msg_time);
    config.lastMsgTime = (s.last_msg_time === null || s.last_msg_time === undefined || s.last_msg_time === "" || !Number.isFinite(plt))
      ? 0
      : plt;
  }

  return config;
}

// ==========================================
// 🚫 封禁状态
// ==========================================

/** 查询用户是否被封禁；老库没有 blocked 字段时按未封禁处理 */
export async function isUserBlocked(env, userKey) {
  if (!env.DB || !userKey) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT blocked FROM users WHERE user_key = ?"
    ).bind(userKey).first();
    return Number(row?.blocked) === 1;
  } catch (e) {
    // 老库还没迁移出 blocked 字段时，按未封禁处理
    return false;
  }
}

/** 设置封禁状态，返回设置后的结果 */
export async function setUserBlocked(env, userKey, blocked) {
  if (!env.DB || !userKey) return false;
  const value = blocked ? 1 : 0;
  await env.DB.prepare(
    "UPDATE users SET blocked = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?"
  ).bind(value, userKey).run();
  return value === 1;
}
