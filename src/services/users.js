// ==========================================
// 👤 用户/场景服务
// ==========================================

import { DEFAULTS } from "../config/constants.js";
import { buildUserKey } from "../core/context.js";
import { escapeHtml } from "../utils/html.js";
import { isBotAdmin } from "./admins.js";

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
  // 机器人管理员（owner / admin / moderator）永远不进封禁名单：封了自己人会让
  // 「谁能进后台」变得不可预期，而且被封的管理员连 /unban 都发不出去
  const targetId = String(userKey).replace(/^user:/, "");
  if (await isBotAdmin(env, targetId)) {
    return false;
  }
  const value = blocked ? 1 : 0;
  await env.DB.prepare(
    "UPDATE users SET blocked = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?"
  ).bind(value, userKey).run();
  return value === 1;
}

// ==========================================
// 🚫 封禁名单（按用户 ID 操作）
// ==========================================

/**
 * 把某个 Telegram 用户 ID 加入封禁名单。
 * 用户从没和机器人说过话时也会建档（积分给 0，避免白送初始积分）。
 * @returns {Promise<{ok:boolean, error?:string, existed?:boolean}>}
 */
export async function banUserById(env, userId, { createdBy = "" } = {}) {
  const id = String(userId ?? "").trim();
  if (!env.DB) return { ok: false, error: "未绑定数据库" };
  if (!/^\d+$/.test(id)) return { ok: false, error: "用户 ID 必须是纯数字（Telegram 数字 ID）" };
  if (await isBotAdmin(env, id)) {
    return { ok: false, error: "不能封禁机器人管理员（owner / 管理员 / 执法员）" };
  }

  const userKey = buildUserKey(id);
  const existed = Boolean(
    await env.DB.prepare("SELECT 1 AS ok FROM users WHERE user_key = ?").bind(userKey).first()
  );

  await env.DB.prepare(`
    INSERT INTO users (user_key, user_id, first_name, points, blocked, updated_at)
    VALUES (?, ?, '未命名', 0, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_key) DO UPDATE SET blocked = 1, updated_at = CURRENT_TIMESTAMP
  `).bind(userKey, id).run();

  return { ok: true, userKey, existed, createdBy };
}

/**
 * 把某个用户 ID 移出封禁名单。
 * @returns {Promise<{ok:boolean, error?:string, userKey?:string}>}
 */
export async function unbanUserById(env, userId) {
  const id = String(userId ?? "").trim();
  if (!env.DB) return { ok: false, error: "未绑定数据库" };
  if (!/^\d+$/.test(id)) return { ok: false, error: "用户 ID 必须是纯数字（Telegram 数字 ID）" };

  const userKey = buildUserKey(id);

  // 注意：SQLite 的 changes 统计的是「命中行数」，把 blocked 从 0 再设成 0 也算 1 行，
  // 所以这里必须先查状态，才能区分「真的解封了」和「本来就不在名单里」。
  const row = await env.DB.prepare(
    "SELECT blocked FROM users WHERE user_key = ?"
  ).bind(userKey).first();
  if (!row) return { ok: false, error: "找不到该用户（可能从未与机器人交互过）", userKey };
  if (Number(row.blocked) !== 1) return { ok: false, error: "该用户不在封禁名单里", userKey };

  await env.DB.prepare(
    "UPDATE users SET blocked = 0, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?"
  ).bind(userKey).run();

  return { ok: true, userKey };
}
/** 分页列出封禁名单（含积分与名字，便于辨认） */
export async function listBlockedUsers(env, page = 1, pageSize = 6) {
  if (!env.DB) return { rows: [], total: 0, page: 1, totalPages: 1 };

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM users WHERE COALESCE(blocked, 0) = 1"
  ).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);

  const { results } = await env.DB.prepare(
    `SELECT id, user_key, user_id, first_name, username, points, updated_at
     FROM users WHERE COALESCE(blocked, 0) = 1
     ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(pageSize, (safePage - 1) * pageSize).all();

  return { rows: results || [], total, page: safePage, totalPages };
}

// ==========================================
// 👥 群组维度浏览（群列表 → 群成员）
// ==========================================

/** 分页列出所有出现过的群（按人数与最近活跃排序） */
export async function listGroupChats(env, page = 1, pageSize = 6) {
  if (!env.DB) return { rows: [], total: 0, page: 1, totalPages: 1 };

  const countRes = await env.DB.prepare(
    "SELECT COUNT(DISTINCT chat_id) AS total FROM user_scenes WHERE chat_type IN ('group','supergroup')"
  ).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);

  const { results } = await env.DB.prepare(
    `SELECT chat_id, COUNT(*) AS members, MAX(updated_at) AS updated_at
     FROM user_scenes
     WHERE chat_type IN ('group','supergroup')
     GROUP BY chat_id
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`
  ).bind(pageSize, (safePage - 1) * pageSize).all();

  return { rows: results || [], total, page: safePage, totalPages };
}

/** 分页列出某个群里的成员场景（点进去就是场景编辑） */
export async function listScenesByChat(env, chatId, page = 1, pageSize = 6) {
  if (!env.DB) return { rows: [], total: 0, page: 1, totalPages: 1 };

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM user_scenes WHERE chat_id = ? AND chat_type IN ('group','supergroup')"
  ).bind(chatId).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.user_key, s.first_name, s.username, s.updated_at,
            COALESCE(u.points, 0) AS points,
            COALESCE(u.blocked, 0) AS blocked
     FROM user_scenes s
     LEFT JOIN users u ON u.user_key = s.user_key
     WHERE s.chat_id = ? AND s.chat_type IN ('group','supergroup')
     ORDER BY s.updated_at DESC
     LIMIT ? OFFSET ?`
  ).bind(chatId, pageSize, (safePage - 1) * pageSize).all();

  return { rows: results || [], total, page: safePage, totalPages };
}

/** 场景行 ID 与 Telegram 用户 ID 的区分阈值：短数字一律当场景行 ID */
const USER_ID_MIN_DIGITS = 5;

/**
 * 把管理员写的「给谁加积分」解析成 user_key。
 *
 * 支持的写法（都是管理端面板里能看到的形态）：
 *   • 场景行 ID —— 用户详情里显示的 `#12`，直接写 `12` 或 `#12`
 *   • 用户 ID  —— `8802544525` 或 `user:8802544525`
 *   • 用户名   —— `@someone`
 * 群 ID（`-100...`）不行：积分的键是 user_key，一个群里有很多成员，
 * 这种情况返回该群前几个成员场景行 ID，引导管理员指明具体是谁。
 *
 * 返回的 error / extra 已经过 HTML 转义，可直接拼进 HTML 消息。
 * @returns {Promise<{ok:true, userKey:string, how:string}|{ok:false, error:string, extra?:string}>}
 */
export async function resolvePointTarget(env, raw) {
  if (!env?.DB) return { ok: false, error: "未绑定数据库。" };
  const target = String(raw || "").trim().replace(/^#/, "");
  if (!target) return { ok: false, error: "没写要加给谁。" };

  // ---------- @用户名 ----------
  if (target.startsWith("@")) {
    const name = target.slice(1).trim();
    if (!name) return { ok: false, error: "用户名不完整。" };
    const row = await env.DB.prepare(
      `SELECT user_key FROM user_scenes
        WHERE LOWER(username) = LOWER(?) AND user_id IS NOT NULL AND user_id <> ''
        ORDER BY updated_at DESC LIMIT 1`
    ).bind(name).first();
    if (!row) {
      return {
        ok: false,
        error: `没找到 @${escapeHtml(name)}。`,
        extra: "对方得先和机器人说过话，我才能查到；也可以直接用<b>用户 ID</b>。"
      };
    }
    return { ok: true, userKey: String(row.user_key), how: `@${escapeHtml(name)}` };
  }

  // ---------- user:<id> / 纯数字（场景行 ID 或用户 ID）----------
  const prefixed = /^user:/i.test(target);
  if (prefixed || /^\d+$/.test(target)) {
    const id = prefixed ? target.replace(/^user:/i, "").trim() : target;
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: "用户 ID 必须是纯数字。" };
    }

    // 没写 user: 前缀的短数字先当「场景行 ID」，这是老用法，也最不容易误伤
    if (!prefixed) {
      const rowId = Number(id);
      if (Number.isSafeInteger(rowId)) {
        const scene = await env.DB.prepare(
          "SELECT user_key FROM user_scenes WHERE id = ?"
        ).bind(rowId).first();
        if (scene) return { ok: true, userKey: String(scene.user_key), how: `场景 #${rowId}` };
      }
      if (id.length < USER_ID_MIN_DIGITS) {
        return { ok: false, error: `没找到场景 #${escapeHtml(id)}。` };
      }
    }

    const userKey = `user:${id}`;
    const user = await env.DB.prepare(
      "SELECT user_key FROM users WHERE user_key = ?"
    ).bind(userKey).first();
    if (!user) {
      return {
        ok: false,
        error: `没找到用户 ${escapeHtml(id)}。`,
        extra: "这个 ID 还没和机器人产生过记录；如果对方是用 @用户名 来的，也可以写 <code>@用户名</code>。"
      };
    }
    return { ok: true, userKey, how: `用户 ${escapeHtml(id)}` };
  }

  // ---------- 群 ID：积分按用户算，得指明是谁 ----------
  if (/^-\d+$/.test(target)) {
    const { results } = await env.DB.prepare(
      `SELECT id, first_name, username FROM user_scenes
        WHERE chat_id = ? AND chat_type IN ('group','supergroup')
        ORDER BY id ASC LIMIT 6`
    ).bind(target).all();
    const rows = results || [];
    if (rows.length === 0) {
      return {
        ok: false,
        error: `没找到群 ${escapeHtml(target)} 里的成员场景。`,
        extra: "可以到「👥 群组用户」里确认机器人是否在这个群。"
      };
    }
    const list = rows
      .map((r) => `#${r.id} ${escapeHtml(r.first_name || "未命名")}${r.username ? `（@${escapeHtml(r.username)}）` : ""}`)
      .join("\n");
    return {
      ok: false,
      error: "群 ID 对应多个成员，而积分是按<b>用户</b>算的，请指定具体是谁：",
      extra: `${list}\n\n• 用 <code>/addpoints &lt;用户ID|@用户名&gt; &lt;数量&gt;</code>\n• 或到「👥 群组用户 → 选群 → 选成员 → 🪙 积分管理」里点着加`
    };
  }

  return {
    ok: false,
    error: "没看懂要给谁加积分。",
    extra:
      "可用写法：\n" +
      "• 场景行 ID：<code>/addpoints 12 100</code>（用户详情里的 <code>#12</code>）\n" +
      "• 用户 ID：<code>/addpoints 8802544525 100</code>\n" +
      "• 用户名：<code>/addpoints @someone 100</code>"
  };
}
