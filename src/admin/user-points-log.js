// ==========================================
// 📜 积分流水
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { ensurePointsLogTable } from "../services/points.js";
import { formatAppTime } from "../services/time.js";

const PAGE_SIZE = 5;

/** 管理员视角：查看某个场景背后的用户积分流水（按最新在前分页） */
export async function renderUserPointsLogMenu(token, env, chatId, messageId, rowId, page = 1) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT user_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return editMessageText(token, chatId, messageId, `❌ 场景 #${rowId} 未找到。`);
  const targetKey = scene.user_key;

  await ensurePointsLogTable(env);

  const countRes = await env.DB.prepare("SELECT COUNT(*) as total FROM points_log WHERE user_key = ?").bind(targetKey).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, PAGE_SIZE);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    "SELECT change_amount, balance_after, reason, created_at FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(targetKey, PAGE_SIZE, pageOffset(safePage, PAGE_SIZE)).all();

  let text = `📜 <b>全局积分流水</b>\n`;
  text += `🔢 场景行 ID: <code>${rowId}</code>\n`;
  text += `💰 积分键: <code>${escapeHtml(targetKey)}</code>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `${LAYOUT.DIVIDER}\n`;

  if (results && results.length > 0) {
    results.forEach(log => {
      const sign = log.change_amount > 0 ? `+${log.change_amount}` : `${log.change_amount}`;
      text += `⏱️ <code>${escapeHtml(formatAppTime(env, log.created_at))}</code>\n`;
      text += `变动: <b>${sign}</b> | 余额: <b>${log.balance_after}</b>\n`;
      text += `原因: ${escapeHtml(log.reason)}\n\n`;
    });
  } else {
    text += `<i>(暂无积分变动记录)</i>\n`;
  }

  const inline_keyboard = [];
  const navRow = pagerRow({ page: safePage, totalPages, prefix: `admin_log_pts_${rowId}_` });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]);
  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}
