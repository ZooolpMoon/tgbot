// ==========================================
// 📜 /points 查看我的积分流水（支持翻页）
// 与「我的积分」相关的按钮都走同一套排版工具，保证两列网格与页码收敛。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText } from "../../telegram/api.js";
import { escapeHtml } from "../../utils/html.js";
import { clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../../utils/layout.js";
import { getUserPoints } from "../../services/users.js";
import { ensurePointsLogTable } from "../../services/points.js";
import { PAGING } from "../../config/constants.js";

/**
 * 渲染积分流水。
 * messageId 为空时新发一条，否则编辑原消息（用于翻页）。
 */
export async function renderPointsLog(token, env, chatId, userKey, page = 1, messageId = null) {
  if (!env.DB) {
    const text = "❌ 未绑定数据库，积分流水不可用。";
    return messageId
      ? editMessageText(token, chatId, messageId, text)
      : sendMessage(token, chatId, text);
  }

  await ensurePointsLogTable(env);

  const pageSize = PAGING.POINTS_PER_PAGE;

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM points_log WHERE user_key = ?"
  ).bind(userKey).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, pageSize);
  const safePage = clampPage(page, totalPages);

  const offset = pageOffset(safePage, pageSize);
  const { results } = await env.DB.prepare(
    "SELECT change_amount, balance_after, reason, created_at FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(userKey, pageSize, offset).all();

  const logs = results || [];
  const points = await getUserPoints(env, userKey);

  let text = `📜 <b>我的积分流水</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `🪙 <b>当前积分：</b> <b>${points}</b>\n`;
  text += `📄 <b>页码：</b> ${safePage} / ${totalPages}（共 ${total} 条）\n\n`;

  if (logs.length === 0) {
    text += `<i>暂无积分变动记录。</i>\n`;
  } else {
    logs.forEach((log, i) => {
      const amount = Number(log.change_amount);
      const balance = Number(log.balance_after);
      const sign = amount > 0 ? `+${amount}` : `${amount}`;
      const icon = amount > 0 ? "🟢" : "🔴";
      text += `${offset + i + 1}. ${icon} <b>${sign}</b> · 余额 <b>${balance}</b>\n`;
      text += `    └ ${escapeHtml(log.reason)}\n`;
      text += `    🕒 <code>${escapeHtml(log.created_at)}</code>\n`;
    });
  }

  const rows = [];
  const navRow = pagerRow({ page: safePage, totalPages, prefix: "points_page_" });
  if (navRow) rows.push(navRow);
  rows.push([{ text: "🏆 积分排行榜", callback_data: "rank_top" }]);

  const keyboard = { inline_keyboard: rows };

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** /points：从第一页开始看流水 */
export async function cmdPoints({ env, token, chatId, userKey }) {
  await renderPointsLog(token, env, chatId, userKey, 1, null);
}
