// ==========================================
// 🚫 封禁名单
//
// 入口：用户管理 → 🚫 封禁名单
// 用途：集中查看所有被封禁的用户，并一键解封；
//       添加封禁用 `/ban <用户ID>`，或在场景编辑里点「🚫 封禁」。
// ==========================================

import { editMessageText, sendMessage, sendMessageWithKeyboard, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { compactLabel, pagerRow, pageInfoText, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { listBlockedUsers, unbanUserById, setUserBlocked } from "../services/users.js";
import { logAdminAction } from "../services/admin-log.js";

const PER_PAGE = 5;

/** 封禁名单键盘（纯函数，便于排版测试）：每行一个解封按钮，避免误触相邻用户 */
export function getBannedListKeyboard(rows, safePage, totalPages) {
  const inline_keyboard = rows.map((row) => {
    const name = String(row.first_name || row.username || row.user_id || "未命名");
    return [{
      text: compactLabel(`✅ 解封 ${name}`, 30),
      callback_data: `${ADMIN_CALLBACK.UNBAN_PREFIX}${row.id}_${safePage}`
    }];
  });

  const navRow = pagerRow({ page: safePage, totalPages, prefix: ADMIN_CALLBACK.BANNED_PREFIX });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回用户管理", callback_data: ADMIN_CALLBACK.USERS_HOME }]);
  return { inline_keyboard };
}

/** 渲染封禁名单 */
export async function renderBannedListMenu(token, env, chatId, messageId, page = 1) {
  if (!env.DB) {
    const text = "❌ 未绑定 D1 数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const { rows, total, page: safePage, totalPages } = await listBlockedUsers(env, page, PER_PAGE);

  let text = `🚫 <b>封禁名单</b>\n`;
  text += `${pageInfoText({ page: safePage, totalPages, total, unit: "人" })}\n`;
  text += `${LAYOUT.DIVIDER}\n`;

  if (rows.length === 0) {
    text += `<i>当前没有封禁用户。</i>\n\n`;
  } else {
    for (const row of rows) {
      const name = row.first_name || row.username || "未命名";
      text += `🚫 <b>${escapeHtml(name)}</b> · 🪙 ${Number(row.points) || 0}\n`;
      text += `    🆔 <code>${escapeHtml(row.user_id || row.user_key || "")}</code>\n`;
    }
    text += `\n`;
  }

  text += `封禁会影响该用户的<b>所有场景</b>（私聊 + 所有群）。\n`;
  text += `添加封禁：<code>/ban &lt;用户ID&gt;</code>，或在场景编辑里点「🚫 封禁」。`;

  const keyboard = getBannedListKeyboard(rows, safePage, totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/**
 * 解封回调：数据形如 admin_unban_<users.id>_<page>
 * 解封后停留在当前页（删到空页时会自动回到上一页）。
 */
export async function handleUnban({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const raw = String(data).replace(ADMIN_CALLBACK.UNBAN_PREFIX, "");
  const [rawId, rawPage] = raw.split("_");
  const rowId = Number.parseInt(rawId, 10);
  const page = Number.parseInt(rawPage, 10) || 1;
  if (!env.DB || !Number.isInteger(rowId)) return;

  const row = await env.DB.prepare(
    "SELECT id, user_key, user_id, first_name FROM users WHERE id = ?"
  ).bind(rowId).first();
  if (!row) {
    await answerCallback(token, callback.id, "❌ 用户不存在", true);
    await renderBannedListMenu(token, env, chatId, msgId, page);
    return;
  }

  await setUserBlocked(env, row.user_key, false);
  await logAdminAction(env, {
    adminId, chatId, action: "user_unblock",
    detail: `${row.first_name || ""} ${row.user_key}（封禁名单解封）`
  });

  const name = row.first_name || row.user_id || row.user_key;
  await answerCallback(token, callback.id, `✅ 已解封 ${name}`, true);
  await renderBannedListMenu(token, env, chatId, msgId, page);
}

/** 供「按 ID 解封」复用：解封单个用户并返回结果文案 */
export async function unbanByUserId(env, userId, { adminId = null, chatId = null } = {}) {
  const res = await unbanUserById(env, userId);
  if (!res.ok) return res;
  await logAdminAction(env, {
    adminId, chatId, action: "user_unblock", detail: `${res.userKey}（按 ID 解封）`
  });
  return res;
}
