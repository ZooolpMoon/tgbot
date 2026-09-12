// ==========================================
// 👥 用户列表
// ==========================================

import { editMessageText, sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, pageInfoText, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";

const PAGE_SIZE = 8;

/**
 * 场景列表键盘（纯函数，便于排版测试）。
 * 8 个场景 = 4 行，加翻页 1 行、返回 1 行，最多 6 行。
 */
export function getUserListKeyboard(rows, safePage, totalPages, isPrivate) {
  const inline_keyboard = [];

  if (rows.length > 0) {
    // 统一两列网格；群聊场景把「群 ID 尾号」写进按钮文案，
    // 因此不需要额外分组标题行（标题行会让行数随群数量线性增长）。
    const buttons = rows.map((u) => {
      const name = String(u.first_name || u.username || u.user_id || "未命名");
      const pts = Number.isFinite(Number(u.points)) ? Number(u.points) : 0;
      const label = isPrivate
        ? `#${u.id} ${name} · 🪙${pts}`
        : `🏠…${String(u.chat_id || "未知").slice(-6)} ${name} · 🪙${pts}`;
      return {
        text: compactLabel(label, 30),
        callback_data: `admin_manage_user_${u.id}`
      };
    });
    inline_keyboard.push(...grid(buttons));
  }

  const pagePrefix = isPrivate ? "admin_users_private_" : "admin_users_group_";
  const navRow = pagerRow({ page: safePage, totalPages, prefix: pagePrefix });
  if (navRow) inline_keyboard.push(navRow);
  // 返回到一级「用户管理」菜单，而不是直接跳回主菜单
  inline_keyboard.push([{ text: "🔙 返回用户管理", callback_data: ADMIN_CALLBACK.USERS_HOME }]);

  return { inline_keyboard };
}

/**
 * 渲染场景列表。
 * @param {string} listType "private" 私聊场景 / "group" 群聊场景
 */
export async function renderUserListMenu(token, env, chatId, messageId, page = 1, listType = "private") {
  if (!env.DB) {
    const t = "❌ 未绑定 D1 数据库。";
    return messageId ? editMessageText(token, chatId, messageId, t) : sendMessage(token, chatId, t);
  }

  const isPrivate = listType === "private";
  const where = isPrivate ? "WHERE s.chat_type = 'private'" : "WHERE s.chat_type IN ('group','supergroup')";

  const countRes = await env.DB.prepare(`SELECT COUNT(*) as total FROM user_scenes s ${where}`).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, PAGE_SIZE);
  // 页码收敛：越界时回到最后一页，避免出现空列表又没有导航按钮
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(`
    SELECT s.id, s.scene_key, s.user_key, s.user_id, s.chat_id, s.chat_type,
           s.username, s.first_name, s.lang,
           COALESCE(u.points, 0) AS points
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    ${where}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, pageOffset(safePage, PAGE_SIZE)).all();

  const title = isPrivate ? "💬 <b>私聊场景列表</b>" : "👥 <b>群聊场景列表</b>";
  let text = `${title}\n${pageInfoText({ page: safePage, totalPages, total, unit: "个" })}\n${LAYOUT.DIVIDER}\n`;
  text += `💡 每个场景独立配置，但积分是全局共享的。\n\n`;

  const rows = results || [];

  if (rows.length === 0) {
    text += `\n<i>(当前没有${isPrivate ? "私聊" : "群聊"}场景记录)</i>\n`;
  }

  const keyboard = getUserListKeyboard(rows, safePage, totalPages, isPrivate);
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}
