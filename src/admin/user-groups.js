// ==========================================
// 👥 群组用户浏览（群列表 → 群成员）
//
// 入口：用户管理 → 👥 群组用户
//   第一级：所有出现过的群（显示群 ID 与人数）
//   第二级：该群的成员场景，点进去就是场景编辑（积分 / 限额 / 频率 / 封禁 / 删除）
//
// 为什么不直接平铺所有群成员：群一多，列表会长到没法用。
// ==========================================

import { editMessageText, sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, pagerRow, pageInfoText, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { listGroupChats, listScenesByChat } from "../services/users.js";

const GROUPS_PER_PAGE = 6;
const MEMBERS_PER_PAGE = 6;

/** 群 ID 太长，按钮上只显示尾号，完整 ID 放在正文里 */
function shortGroupId(chatId) {
  const raw = String(chatId || "");
  return raw.length > 8 ? `…${raw.slice(-8)}` : raw;
}

/** 群列表键盘（纯函数，便于排版测试） */
export function getGroupListKeyboard(rows, safePage, totalPages) {
  const inline_keyboard = grid(
    rows.map((row) => ({
      text: compactLabel(`🏠 ${shortGroupId(row.chat_id)} · 👤${Number(row.members) || 0}`, 30),
      callback_data: `${ADMIN_CALLBACK.GROUP_MEMBERS_PREFIX}${row.chat_id}_1`
    }))
  );

  const navRow = pagerRow({ page: safePage, totalPages, prefix: ADMIN_CALLBACK.USER_GROUPS_PREFIX });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回用户管理", callback_data: ADMIN_CALLBACK.USERS_HOME }]);
  return { inline_keyboard };
}

/** 群成员键盘（纯函数，便于排版测试） */
export function getGroupMembersKeyboard(rows, safePage, totalPages, chatId) {
  const inline_keyboard = grid(
    rows.map((row) => {
      const name = String(row.first_name || row.username || row.user_id || "未命名");
      const pts = Number.isFinite(Number(row.points)) ? Number(row.points) : 0;
      const badge = Number(row.blocked) === 1 ? "🚫" : "👤";
      return {
        text: compactLabel(`${badge} #${row.id} ${name} · 🪙${pts}`, 30),
        callback_data: `admin_manage_user_${row.id}`
      };
    })
  );

  const navRow = pagerRow({
    page: safePage,
    totalPages,
    prefix: `${ADMIN_CALLBACK.GROUP_MEMBERS_PREFIX}${chatId}_`
  });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回群列表", callback_data: `${ADMIN_CALLBACK.USER_GROUPS_PREFIX}1` }]);
  return { inline_keyboard };
}

/** 渲染群列表 */
export async function renderGroupListMenu(token, env, chatId, messageId, page = 1) {
  if (!env.DB) {
    const text = "❌ 未绑定 D1 数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const { rows, total, page: safePage, totalPages } = await listGroupChats(env, page, GROUPS_PER_PAGE);

  let text = `👥 <b>群组用户</b>\n`;
  text += `${pageInfoText({ page: safePage, totalPages, total, unit: "个群" })}\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `点一个群进去看成员（每个成员是一个独立场景）：\n\n`;

  if (rows.length === 0) {
    text += `<i>还没有群聊记录。把机器人拉进群并 @ 一次就会出现。</i>\n`;
  } else {
    for (const row of rows) {
      text += `🏠 <code>${escapeHtml(row.chat_id)}</code> · 👤 ${Number(row.members) || 0} 个成员场景\n`;
    }
  }

  const keyboard = getGroupListKeyboard(rows, safePage, totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 渲染某个群的成员列表 */
export async function renderGroupMembersMenu(token, env, chatId, messageId, groupChatId, page = 1) {
  if (!env.DB) {
    const text = "❌ 未绑定 D1 数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const groupId = String(groupChatId || "").trim();
  const { rows, total, page: safePage, totalPages } = await listScenesByChat(env, groupId, page, MEMBERS_PER_PAGE);

  let text = `👥 <b>群 <code>${escapeHtml(groupId)}</code> 的成员</b>\n`;
  text += `${pageInfoText({ page: safePage, totalPages, total, unit: "人" })}\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `👤 正常 · 🚫 已封禁 · 🪙 全局积分\n\n`;

  if (rows.length === 0) {
    text += `<i>这个群还没有成员场景记录。</i>\n`;
  } else {
    for (const row of rows) {
      const name = row.first_name || row.username || row.user_id || "未命名";
      text += `${Number(row.blocked) === 1 ? "🚫" : "👤"} #${row.id} ${escapeHtml(name)} · 🪙 ${Number(row.points) || 0}\n`;
      text += `    🆔 <code>${escapeHtml(row.user_id || "")}</code>\n`;
    }
  }

  const keyboard = getGroupMembersKeyboard(rows, safePage, totalPages, groupId);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}
