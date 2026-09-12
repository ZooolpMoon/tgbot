// ==========================================
// 🏷️ 群组标签（Telegram 成员标签）
//
// 商城里的「自定义群组标签」卖的是 Telegram 的成员标签：
//   setChatMemberTag(chat_id, user_id, tag)
// 前提是**机器人在那个群是管理员**，并且勾了「管理标签」（can_manage_tags）权限；
// 标签 0~16 字符、不允许 emoji（Telegram 的硬限制）。
//
// 本模块只负责「业务能力」：校验标签文本、列出可选群、查权限、真正设置。
// 引导式交互在 shop/tags.js。
// ==========================================

import { getChat, getChatMember, setChatMemberTag } from "../telegram/api.js";
import { resolveBotId } from "./guard.js";
import { logError, logWarn } from "../core/logger.js";

/** Telegram 限制：标签最多 16 个字符，且不允许 emoji */
export const TAG_MAX_LENGTH = 16;

/** 一次最多列多少个群（渲染时要挂按钮，行数受排版约定限制） */
export const TAG_GROUPS_LIMIT = 60;

/** 权限检查结果的缓存时长（秒）：避免每次进流程都调 Telegram */
const RIGHTS_TTL_SEC = 3600;

/** 清空标签的快捷输入（和其它引导流程的「- 表示清空」保持一致） */
export const TAG_CLEAR_INPUT = "-";

/**
 * 校验用户输入的标签。
 * @returns {{ok:true, tag:string}|{ok:false, error:string}} tag 为空串表示清除标签
 */
export function validateTagText(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "标签不能为空。" };
  if (text === TAG_CLEAR_INPUT) return { ok: true, tag: "" };
  if (/[\n\r\t]/.test(text)) return { ok: false, error: "标签只能是一行文字。" };
  if (/\p{Extended_Pictographic}/u.test(text)) {
    return { ok: false, error: "Telegram 不允许标签里带 emoji，换成纯文字吧。" };
  }
  if ([...text].length > TAG_MAX_LENGTH) {
    return { ok: false, error: `标签最多 ${TAG_MAX_LENGTH} 个字（你发了 ${[...text].length} 个）。` };
  }
  return { ok: true, tag: text };
}

/** 把 Telegram 的错误描述翻译成用户能看懂的话 */
function describeTagError(description, errorCode) {
  const raw = String(description || "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("not enough rights") || lower.includes("chat_admin_required")
    || lower.includes("method is not available")) {
    return "机器人没有「管理标签」权限：请让群管理员把机器人设为管理员，并勾选『管理标签』。";
  }
  if (lower.includes("participant not found") || lower.includes("user not found")
    || lower.includes("user_not_participant")) {
    return "你不在这个群里（或者已经退群），换一个群试试。";
  }
  if (lower.includes("tag_invalid") || lower.includes("emoji")) {
    return "标签内容不合规：最多 16 个字、不能有 emoji。";
  }
  if (lower.includes("chat_creator_required")) {
    return "Telegram 拒绝了这次设置（CHAT_CREATOR_REQUIRED）：成员标签只对普通成员生效，"
      + "群主和管理员都不行。如果你本来就是普通成员，那说明这个群要求由群主来管理标签。";
  }
  if (lower.includes("participant_missing") || lower.includes("user_not_participant")
    || lower.includes("not a member")) {
    return "你不在这个群里（或者已经退群），换一个群试试。";
  }
  if (lower.includes("chat not found")) return "找不到这个群：机器人可能已被移出。";
  return raw ? `设置失败：${raw}` : `设置失败（错误码 ${errorCode || "未知"}）`;
}

/** 读一条群缓存 */
async function readBotChat(env, chatId) {
  if (!env?.DB) return null;
  try {
    return await env.DB.prepare(
      "SELECT chat_id, title, tags_ok, checked_at FROM bot_chats WHERE chat_id = ?"
    ).bind(String(chatId)).first();
  } catch (e) {
    logError("读取群缓存失败：", e);
    return null;
  }
}

/** 写一条群缓存（只更新传入的字段） */
async function saveBotChat(env, chatId, { title = null, tagsOk = null } = {}) {
  if (!env?.DB) return;
  const current = await readBotChat(env, chatId);
  const nextTitle = title === null ? String(current?.title || "") : String(title);
  const nextTagsOk = tagsOk === null ? Number(current?.tags_ok ?? -1) : Number(tagsOk);
  const nextCheckedAt = tagsOk === null
    ? Number(current?.checked_at || 0)
    : Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO bot_chats (chat_id, title, tags_ok, checked_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        title      = EXCLUDED.title,
        tags_ok    = EXCLUDED.tags_ok,
        checked_at = EXCLUDED.checked_at,
        updated_at = CURRENT_TIMESTAMP
    `).bind(String(chatId), nextTitle, nextTagsOk, nextCheckedAt).run();
  } catch (e) {
    logError("写入群缓存失败：", e);
  }
}

/**
 * 机器人见过的群（来自 user_scenes），买家自己所在的群排在前面。
 * 群名从 bot_chats 缓存读；没有的留空，由调用方按需补 getChat。
 */
export async function listTagGroups(env, userId, { limit = TAG_GROUPS_LIMIT } = {}) {
  if (!env?.DB) return [];
  const max = Math.max(1, Math.floor(limit) || TAG_GROUPS_LIMIT);

  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT chat_id, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
         FROM user_scenes
        WHERE chat_type IN ('group', 'supergroup') AND chat_id IS NOT NULL AND chat_id <> ''
        GROUP BY chat_id
        ORDER BY mine DESC, chat_id ASC
        LIMIT ?`
    ).bind(String(userId || ""), max).all();
    rows = results || [];
  } catch (e) {
    logError("读取群列表失败：", e);
    return [];
  }
  if (rows.length === 0) return [];

  const titles = new Map();
  try {
    const { results } = await env.DB.prepare(
      "SELECT chat_id, title FROM bot_chats WHERE title <> ''"
    ).all();
    for (const row of results || []) titles.set(String(row.chat_id), String(row.title));
  } catch (e) {
    logError("读取群名缓存失败：", e);
  }

  return rows.map((row) => ({
    chatId: String(row.chat_id),
    title: titles.get(String(row.chat_id)) || "",
    mine: Number(row.mine) === 1
  }));
}

/**
 * 补齐群名：缓存里没有的调一次 getChat（结果写回缓存）。
 * 机器人已经不在的群会被标 `gone`，由调用方过滤掉——比让用户点了才发现要清楚。
 */
export async function fillGroupTitles(token, env, groups) {
  const out = [];
  for (const group of groups) {
    if (group.title) {
      out.push(group);
      continue;
    }
    const json = await getChat(token, group.chatId);
    const title = json?.ok ? String(json.result?.title || "") : "";
    if (json?.ok && title) {
      await saveBotChat(env, group.chatId, { title });
      out.push({ ...group, title });
    } else {
      out.push({ ...group, gone: true, title: `群 ${group.chatId}` });
    }
  }
  return out;
}

/**
 * 机器人能不能在这个群设标签（结果缓存 1 小时）。
 * @returns {Promise<{canManageTags:boolean, isAdmin?:boolean, status?:string}>}
 */
export async function getBotTagRights(token, env, chatId) {
  const cached = await readBotChat(env, chatId);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && Number(cached.tags_ok) >= 0 && Number(cached.checked_at) > nowSec - RIGHTS_TTL_SEC) {
    return { canManageTags: Number(cached.tags_ok) === 1, cached: true };
  }

  const botId = await resolveBotId(token);
  if (!botId) return { canManageTags: false, status: "unknown" };

  const json = await getChatMember(token, chatId, botId);
  const member = json?.ok ? json.result : null;
  const status = member?.status || "unknown";
  const isAdmin = status === "administrator" || status === "creator";
  const canManageTags = isAdmin && (status === "creator" || Boolean(member?.can_manage_tags));

  await saveBotChat(env, chatId, { tagsOk: canManageTags ? 1 : 0 });
  return { canManageTags, isAdmin, status };
}

/**
 * 目标用户在这个群「能不能有标签」。
 *
 * Telegram 的成员标签只对**普通成员**生效（方法说明就是 "set a tag for a regular member"）：
 *   • 群主（creator）——名字由「管理员头衔」控制，机器人改不了，实测返回 CHAT_CREATOR_REQUIRED
 *   • 管理员 —— 同样走「管理员头衔」，标签不适用
 *   • 已退群 / 被踢 —— 根本不在群里
 * 提前查一次，比让用户填完标签再失败要好。
 *
 * @returns {Promise<{ok:boolean, code?:string, error?:string}>}
 */
export async function checkTagTarget({ token, chatId, userId }) {
  let member = null;
  try {
    const json = await getChatMember(token, chatId, userId);
    member = json?.ok ? json.result : null;
  } catch (e) {
    logError("查询成员身份失败：", e);
  }
  // 查不到（网络抖动 / 接口异常）就不拦，交给真正设置时的报错
  if (!member) return { ok: true };

  const status = String(member.status || "");
  if (status === "creator") {
    return {
      ok: false,
      code: "creator",
      error: "你是这个群的<b>群主</b>，而 Telegram 的成员标签只能给<b>普通成员</b>设置"
        + "（群主的名字由「管理员头衔」控制，机器人改不了）。换一个你在里面是普通成员的群吧。"
    };
  }
  if (status === "administrator") {
    return {
      ok: false,
      code: "administrator",
      error: "你在那个群里是<b>管理员</b>，成员标签只对<b>普通成员</b>生效（管理员走的是「管理员头衔」）。"
        + "换一个你是普通成员的群吧。"
    };
  }
  if (status === "left" || status === "kicked") {
    return {
      ok: false,
      code: "absent",
      error: "你不在这个群里（或者已经退群），换一个群试试。"
    };
  }
  return { ok: true, status };
}

/** 读「机器人给这个用户在这个群设过的标签」 */
export async function getAppliedTag(env, chatId, userId) {
  if (!env?.DB) return null;
  try {
    return await env.DB.prepare(
      "SELECT tag, order_id, updated_at FROM user_group_tags WHERE chat_id = ? AND user_id = ?"
    ).bind(String(chatId), String(userId)).first();
  } catch (e) {
    logError("读取群标签失败：", e);
    return null;
  }
}

/**
 * 真正设置标签，并把结果写进 user_group_tags（当前值 + 审计）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function applyMemberTag({ env, token, chatId, userId, tag, orderId = 0 }) {
  const value = String(tag || "");
  const json = await setChatMemberTag(token, chatId, userId, value);
  if (json && json.ok === false) {
    logWarn("设置群标签失败：", `${chatId} ${userId} ${json.description || ""}`);
    return { ok: false, error: describeTagError(json.description, json.error_code) };
  }

  try {
    await env.DB.prepare(`
      INSERT INTO user_group_tags (chat_id, user_id, tag, order_id, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        tag = EXCLUDED.tag, order_id = EXCLUDED.order_id, updated_at = CURRENT_TIMESTAMP
    `).bind(
      String(chatId), String(userId), value, Math.max(0, Math.floor(orderId) || 0)
    ).run();
  } catch (e) {
    // 标签已经生效了，记录失败不该让用户以为白买
    logError("记录群标签失败（标签已生效）：", e);
  }
  return { ok: true };
}
