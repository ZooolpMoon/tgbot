// ==========================================
// 💸 /transfer 积分转账（v3.0.0）
//
// 用法（三种指认方式，和处置指令一致）：
//   /transfer 123456789 50          直接写用户 ID
//   /transfer @someone 50           写用户名（对方得先和机器人交互过）
//   （回复对方消息）/transfer 50     最可靠
//
// 约束：不能转给自己；余额必须够；对方必须在本机器人里有过记录。
// 扣分用原子条件更新，给对方加分失败会自动退回。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { escapeHtml } from "../../utils/html.js";
import { TRANSFER } from "../../config/constants.js";
import { adjustPoints, logPointChange, tryDeductPoints, refundPoint } from "../../services/points.js";
import { buildUserKey } from "../../core/context.js";
import { findUserByUsername } from "../../services/guard.js";
import { logError } from "../../core/logger.js";

const USAGE =
  "💸 <b>积分转账</b>\n-------------------------\n" +
  "用法：<code>/transfer &lt;用户ID|@用户名&gt; &lt;数量&gt;</code>\n" +
  "也可以先<b>回复对方的消息</b>，再发 <code>/transfer 50</code>。\n\n" +
  `• 单笔范围：${TRANSFER.MIN} ~ ${TRANSFER.MAX} 积分\n` +
  "• 不能转给自己；对方必须用过本机器人\n" +
  "• 转账不计入每日任务，扣分与到账都有流水";

/** 解析收款人：回复 > 数字 ID > @用户名 */
async function resolveTarget({ env, message }) {
  const replied = message?.reply_to_message?.from;
  if (replied?.id && !replied.is_bot) {
    return { userId: String(replied.id), label: replied.username ? `@${replied.username}` : (replied.first_name || String(replied.id)) };
  }

  const entities = Array.isArray(message?.entities) ? message.entities : [];
  for (const e of entities) {
    if (e.type === "text_mention" && e.user?.id && !e.user.is_bot) {
      return { userId: String(e.user.id), label: e.user.username ? `@${e.user.username}` : (e.user.first_name || String(e.user.id)) };
    }
    if (e.type === "mention") {
      const chunk = String(message.text || "").slice(e.offset || 0, (e.offset || 0) + (e.length || 0)).trim();
      const found = await findUserByUsername(env, chunk.replace(/^@/, ""));
      if (found) return { userId: String(found.user_id), label: chunk };
      return { error: `没找到 ${escapeHtml(chunk)} 对应的用户（对方得先用过本机器人）` };
    }
  }
  return null;
}

/** /transfer：把积分转给另一个用户 */
export async function cmdTransfer({ env, ctx, token, chatId, userKey, isGroupCtx, rawText, message, uctx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const body = String(rawText || "").replace(/^\/transfer(@\w+)?/i, "").trim();
  if (!body) {
    await sendAutoDelete(token, chatId, USAGE, "HTML", isGroupCtx, ctx);
    return;
  }

  // 金额 = 最后一段纯数字；其余部分用于指认收款人
  const tokens = body.split(/\s+/).filter(Boolean);
  const amountToken = tokens.length > 1 ? tokens[tokens.length - 1] : tokens[0];
  const amount = /^\d+$/.test(amountToken) ? Number.parseInt(amountToken, 10) : NaN;
  if (!Number.isInteger(amount) || amount < TRANSFER.MIN || amount > TRANSFER.MAX) {
    await sendAutoDelete(token, chatId, `⚠️ 转账数量需要是 ${TRANSFER.MIN} ~ ${TRANSFER.MAX} 之间的整数。\n\n${USAGE}`, "HTML", isGroupCtx, ctx);
    return;
  }

  // 收款人：先看回复 / @用户名（留言里的数字留给金额）
  let target = await resolveTarget({ env, message });
  if (target?.error) {
    await sendAutoDelete(token, chatId, `⚠️ ${target.error}`, "HTML", isGroupCtx, ctx);
    return;
  }

  if (!target) {
    const idToken = tokens.length > 1 ? tokens[0] : null;
    if (!idToken || !/^\d+$/.test(idToken)) {
      await sendAutoDelete(token, chatId, USAGE, "HTML", isGroupCtx, ctx);
      return;
    }
    target = { userId: idToken, label: idToken };
  }

  const targetId = String(target.userId);
  if (targetId === String(uctx.userId)) {
    await sendAutoDelete(token, chatId, "⚠️ 不能给自己转账。", null, isGroupCtx, ctx);
    return;
  }
  if (env.MY_TELEGRAM_ID && targetId === String(env.MY_TELEGRAM_ID)) {
    // 转给管理员是允许的（比如交罚款 / 打赏），这里只提示一句
  }

  const targetKey = buildUserKey(targetId);
  const targetUser = await env.DB.prepare("SELECT user_key FROM users WHERE user_key = ?").bind(targetKey).first();
  if (!targetUser) {
    await sendAutoDelete(
      token, chatId,
      "⚠️ 对方还没有和机器人交互过（没有账户），无法接收积分。\n让对方先私聊发一句 <code>/start</code> 即可。",
      "HTML", isGroupCtx, ctx
    );
    return;
  }

  // 先扣自己的（原子，余额不足直接失败）
  const afterDeduct = await tryDeductPoints(env, userKey, amount);
  if (afterDeduct === null) {
    await sendAutoDelete(token, chatId, "⚠️ 积分不足，转账失败。", null, isGroupCtx, ctx);
    return;
  }

  const afterCredit = await adjustPoints(env, targetKey, amount);
  if (afterCredit === null) {
    await refundPoint(env, userKey, amount, "转账失败自动退回");
    logError("转账失败：目标用户加分失败", targetKey);
    await sendAutoDelete(token, chatId, "❌ 转账失败，积分已退回。", null, isGroupCtx, ctx);
    return;
  }

  const fromLabel = uctx.username ? `@${uctx.username}` : (uctx.firstName || uctx.userId);
  await logPointChange(env, userKey, -amount, afterDeduct, `转账给 ${target.label}（${targetId}）`);
  await logPointChange(env, targetKey, amount, afterCredit, `收到 ${fromLabel} 的转账`);

  await sendAutoDelete(
    token, chatId,
    `💸 <b>转账成功</b>\n` +
    `-------------------------\n` +
    `👤 收款人：<b>${escapeHtml(target.label)}</b>（<code>${escapeHtml(targetId)}</code>）\n` +
    `🪙 金额：<b>${amount}</b> 积分\n` +
    `💰 我的余额：<b>${afterDeduct}</b>`,
    "HTML", isGroupCtx, ctx
  );
}
