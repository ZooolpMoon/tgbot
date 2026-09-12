// ==========================================
// /points 查看我的积分流水
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { escapeHtml } from "../../utils/html.js";

export async function cmdPoints({ env, ctx, token, chatId, userKey, isGroupCtx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库，积分流水不可用。", null, isGroupCtx, ctx);
    return;
  }

  const { results } = await env.DB.prepare(
    "SELECT change_amount, balance_after, reason, created_at FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT 10"
  ).bind(userKey).all();

  const logs = results || [];

  let text = `📜 <b>我的积分流水</b>\n`;
  text += `-------------------------\n`;
  text += `💰 <b>积分键：</b> <code>${escapeHtml(userKey)}</code>\n\n`;

  if (logs.length === 0) {
    text += `<i>暂无积分变动记录。</i>\n`;
  } else {
    logs.forEach((log, i) => {
      const amount = Number(log.change_amount);
      const balance = Number(log.balance_after);
      const sign = amount > 0 ? `+${amount}` : `${amount}`;
      text += `${i + 1}. <b>${sign}</b> · 余额 <b>${balance}</b>\n`;
      text += `    └ ${escapeHtml(log.reason)}\n`;
      text += `    🕒 <code>${escapeHtml(log.created_at)}</code>\n`;
    });
  }

  await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx);
}
