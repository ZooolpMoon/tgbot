// ==========================================
// 👤 用户/场景服务
// ==========================================

import { DEFAULTS } from "../config/constants.js";

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

export async function getUserPoints(env, userKey) {
  if (!env.DB) return DEFAULTS.POINTS;
  const u = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(userKey).first();
  return u && Number.isFinite(Number(u.points)) ? Math.max(0, Math.floor(Number(u.points))) : DEFAULTS.POINTS;
}

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

    const pmd = Number(s.max_daily);
    if (s.max_daily === null || s.max_daily === undefined || s.max_daily === "" || !Number.isFinite(pmd)) {
      config.maxDaily = DEFAULTS.MAX_DAILY;
    } else if (pmd === DEFAULTS.UNLIMITED) {
      config.maxDaily = DEFAULTS.UNLIMITED;
    } else {
      config.maxDaily = Math.max(0, Math.floor(pmd));
    }

    const prl = Number(s.rate_limit_sec);
    config.rateLimitSec = (s.rate_limit_sec === null || s.rate_limit_sec === undefined || s.rate_limit_sec === "" || !Number.isFinite(prl))
      ? DEFAULTS.RATE_LIMIT_SEC
      : Math.max(0, Math.floor(prl));

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

export async function setUserBlocked(env, userKey, blocked) {
  if (!env.DB || !userKey) return false;
  const value = blocked ? 1 : 0;
  await env.DB.prepare(
    "UPDATE users SET blocked = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?"
  ).bind(value, userKey).run();
  return value === 1;
}
