// ==========================================
// 📜 积分流水
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { ensurePointsLogTable } from "../services/points.js";

export async function renderUserPointsLogMenu(token, env, chatId, messageId, rowId, page = 1) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT user_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return editMessageText(token, chatId, messageId, `❌ 场景 #${rowId} 未找到。`);
  const targetKey = scene.user_key;

  const pageSize = 5;
  const offset = (page - 1) * pageSize;
  await ensurePointsLogTable(env);

  const countRes = await env.DB.prepare("SELECT COUNT(*) as total FROM points_log WHERE user_key = ?").bind(targetKey).first();
  const total = countRes ? countRes.total : 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const { results } = await env.DB.prepare(
    "SELECT change_amount, balance_after, reason, created_at FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(targetKey, pageSize, offset).all();

  let text = `📜 <b>全局积分流水</b>\n`;
  text += `🔢 场景行 ID: <code>${rowId}</code>\n`;
  text += `💰 积分键: <code>${escapeHtml(targetKey)}</code>\n`;
  text += `页码：<b>${page} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `-------------------------\n`;

  if (results && results.length > 0) {
    results.forEach(log => {
      const sign = log.change_amount > 0 ? `+${log.change_amount}` : `${log.change_amount}`;
      text += `⏱️ <code>${log.created_at}</code>\n`;
      text += `变动: <b>${sign}</b> | 余额: <b>${log.balance_after}</b>\n`;
      text += `原因: ${escapeHtml(log.reason)}\n\n`;
    });
  } else {
    text += `<i>(暂无积分变动记录)</i>\n`;
  }

  const inline_keyboard = [];
  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `admin_log_pts_${rowId}_${page - 1}` });
  if (page < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `admin_log_pts_${rowId}_${page + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]);
  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}