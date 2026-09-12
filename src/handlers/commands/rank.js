// ==========================================
// 🏆 /rank 积分排行榜
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, deleteMessage } from "../../telegram/api.js";
import { escapeHtml } from "../../utils/html.js";
import { LAYOUT } from "../../utils/layout.js";
import { PAGING } from "../../config/constants.js";

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * 渲染积分 Top N 排行榜。
 * messageId 为空时新发一条，否则编辑原消息（用于刷新）。
 */
export async function renderRank(token, env, chatId, messageId = null, userKey = null) {
  if (!env.DB) {
    const text = "❌ 未绑定数据库，排行榜不可用。";
    return messageId
      ? editMessageText(token, chatId, messageId, text)
      : sendMessage(token, chatId, text);
  }

  const topN = PAGING.RANK_TOP;
  const { results } = await env.DB.prepare(
    "SELECT user_key, user_id, first_name, username, points FROM users ORDER BY points DESC, updated_at ASC LIMIT ?"
  ).bind(topN).all();

  const rows = results || [];

  let myRank = null;
  let myPoints = 0;
  if (userKey) {
    const me = await env.DB.prepare(
      "SELECT points FROM users WHERE user_key = ?"
    ).bind(userKey).first();
    myPoints = Number.isFinite(Number(me?.points)) ? Math.max(0, Math.floor(Number(me.points))) : 0;

    const above = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE points > ?"
    ).bind(myPoints).first();
    myRank = (Number(above?.n) || 0) + 1;
  }

  let text = `🏆 <b>积分排行榜</b> · Top ${topN}\n`;
  text += `${LAYOUT.DIVIDER}\n`;

  if (rows.length === 0) {
    text += `<i>还没有积分数据，快去签到赚积分吧～</i>\n`;
  } else {
    rows.forEach((u, i) => {
      const rank = i + 1;
      const badge = MEDALS[i] || `#${rank}`;
      const name = u.first_name || u.username || u.user_id || "匿名用户";
      const pts = Number.isFinite(Number(u.points)) ? Math.max(0, Math.floor(Number(u.points))) : 0;
      const isMe = userKey && u.user_key === userKey;
      text += `${badge} ${isMe ? "<b>" : ""}${escapeHtml(name)}${isMe ? "（我）</b>" : ""} — 🪙 <b>${pts}</b>\n`;
    });
  }

  if (myRank !== null) {
    text += `\n👤 <b>我的排名：</b> 第 <b>${myRank}</b> 名 · 🪙 <b>${myPoints}</b>`;
    if (myRank > topN) {
      text += `\n<i>（继续签到、玩小游戏赚积分，冲击 Top ${topN}！）</i>`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 刷新排行榜", callback_data: "rank_top" },
        { text: "📜 我的积分流水", callback_data: "points_page_1" }
      ],
      [{ text: "❌ 关闭", callback_data: "rank_close" }]
    ]
  };

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** /rank：新发一条排行榜（并标注「我」的排名） */
export async function cmdRank({ env, token, chatId, userKey }) {
  await renderRank(token, env, chatId, null, userKey);
}

/** 关闭排行榜：直接删掉这条卡片 */
export async function closeRank(token, chatId, messageId) {
  return deleteMessage(token, chatId, messageId);
}
