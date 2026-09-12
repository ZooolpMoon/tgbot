// ==========================================
// 📢 管理员群发消息
// /broadcast <内容>  →  二次确认  →  分批推送给所有私聊用户
// ==========================================

import {
  sendMessage,
  sendMessageWithKeyboard,
  editMessageText
} from "../../telegram/api.js";
import { sendAutoDelete, sleep } from "../../telegram/auto-delete.js";
import { BROADCAST } from "../../config/constants.js";
import { ERR } from "../../config/messages.js";
import { escapeHtml } from "../../utils/html.js";
import { logAdminAction } from "../../services/admin-log.js";
import { logError } from "../../core/logger.js";

const RECIPIENTS_SQL = `
  SELECT id, user_id FROM users
  WHERE id > ?
    AND user_id IS NOT NULL AND user_id <> ''
    AND COALESCE(blocked, 0) = 0
  ORDER BY id ASC
  LIMIT ?
`;

// ---------- /broadcast <内容> ----------
export async function cmdBroadcast({ env, ctx, token, chatId, isMaster, isGroupCtx, rawText }) {
  if (!isMaster) {
    await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, ctx);
    return;
  }
  if (isGroupCtx) {
    await sendAutoDelete(token, chatId, "📢 群发消息仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
    return;
  }
  if (!env.DB) {
    await sendAutoDelete(token, chatId, ERR.DB_NOT_BOUND, null, isGroupCtx, ctx);
    return;
  }

  const content = String(rawText || "").replace(/^\/broadcast(@\w+)?/i, "").trim();
  if (!content) {
    await sendMessage(
      token,
      chatId,
      "📢 <b>群发消息</b>\n-------------------------\n" +
      "用法：<code>/broadcast 消息内容</code>\n\n" +
      "• 会发送给所有<b>私聊过机器人且未被封禁</b>的用户\n" +
      "• 发送前会二次确认，正文按纯文本推送（不解析 HTML）\n" +
      `• 正文最长 ${BROADCAST.MAX_CHARS} 字符`,
      "HTML"
    );
    return;
  }

  const body = content.slice(0, BROADCAST.MAX_CHARS);

  await env.DB.prepare(`
    INSERT INTO broadcast_drafts (chat_id, content, cursor_id, sent, failed, created_at, updated_at)
    VALUES (?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      content = EXCLUDED.content,
      cursor_id = 0,
      sent = 0,
      failed = 0,
      updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, body).run();

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE user_id IS NOT NULL AND user_id <> '' AND COALESCE(blocked, 0) = 0"
  ).first();
  const targets = Number(countRes?.n) || 0;

  const text =
    `📢 <b>确认群发？</b>\n` +
    `-------------------------\n` +
    `👥 <b>预计接收用户：</b> ${targets} 人\n` +
    `🕒 <b>提交时间：</b> ${new Date().toISOString()}\n\n` +
    `📝 <b>正文预览：</b>\n${escapeHtml(body)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ 确认发送", callback_data: "admin_broadcast_confirm" },
        { text: "❌ 取消", callback_data: "admin_broadcast_cancel" }
      ]
    ]
  };

  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ---------- 取消群发 ----------
export async function cancelBroadcast({ env, token, chatId, messageId, adminId }) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM broadcast_drafts WHERE chat_id = ?").bind(chatId).run();
  }
  await editMessageText(token, chatId, messageId, "🚫 已取消本次群发。", { inline_keyboard: [] });
  await logAdminAction(env, { adminId, chatId, action: "broadcast_cancel", detail: "" });
}

// ---------- 开始 / 继续群发 ----------
export async function startBroadcast({ env, ctx, token, chatId, messageId = null, adminId }) {
  if (!env.DB) return;

  const draft = await env.DB.prepare(
    "SELECT * FROM broadcast_drafts WHERE chat_id = ?"
  ).bind(chatId).first();

  if (!draft) {
    const msg = "⚠️ 没有待发送的群发内容（草稿可能已被取消或发送完成）。";
    if (messageId) return editMessageText(token, chatId, messageId, msg, { inline_keyboard: [] });
    return sendMessage(token, chatId, msg);
  }

  if (messageId) {
    await editMessageText(
      token, chatId, messageId,
      `🚀 <b>群发进行中…</b>\n-------------------------\n已成功 <b>${Number(draft.sent) || 0}</b> 人，失败 <b>${Number(draft.failed) || 0}</b> 人。\n发送完成后会在这里汇报结果。`,
      { inline_keyboard: [] }, "HTML"
    );
  }

  const task = runBroadcast({ env, token, chatId, adminId });
  if (ctx?.waitUntil) ctx.waitUntil(task);
  else await task;
}

/**
 * 分批推送。每批结束都会持久化进度，
 * 超出单次时间预算时保存 cursor 并提示管理员点「继续发送」。
 */
async function runBroadcast({ env, token, chatId, adminId }) {
  try {
    const startedAt = Date.now();

    while (true) {
      const draft = await env.DB.prepare(
        "SELECT * FROM broadcast_drafts WHERE chat_id = ?"
      ).bind(chatId).first();
      if (!draft) return;

      let cursor = Number(draft.cursor_id) || 0;
      let sent = Number(draft.sent) || 0;
      let failed = Number(draft.failed) || 0;

      if (sent + failed >= BROADCAST.MAX_RECIPIENTS) {
        await env.DB.prepare("DELETE FROM broadcast_drafts WHERE chat_id = ?").bind(chatId).run();
        await sendMessage(
          token, chatId,
          `⚠️ <b>群发已停止</b>\n-------------------------\n已达到单次上限 ${BROADCAST.MAX_RECIPIENTS} 人。\n成功 <b>${sent}</b> 人，失败 <b>${failed}</b> 人。`,
          "HTML"
        );
        return;
      }

      const { results } = await env.DB.prepare(RECIPIENTS_SQL)
        .bind(cursor, BROADCAST.BATCH_SIZE)
        .all();
      const rows = results || [];

      // 没有更多接收者 → 收尾
      if (rows.length === 0) {
        await env.DB.prepare("DELETE FROM broadcast_drafts WHERE chat_id = ?").bind(chatId).run();
        await logAdminAction(env, {
          adminId, chatId, action: "broadcast_done",
          detail: `成功 ${sent} / 失败 ${failed}`
        });
        await sendMessage(
          token, chatId,
          `✅ <b>群发完成</b>\n-------------------------\n📤 成功：<b>${sent}</b> 人\n❌ 失败：<b>${failed}</b> 人（已拉黑机器人或账号失效）`,
          "HTML"
        );
        return;
      }

      for (const row of rows) {
        if (Date.now() - startedAt > BROADCAST.TIME_BUDGET_MS) {
          await env.DB.prepare(
            "UPDATE broadcast_drafts SET cursor_id = ?, sent = ?, failed = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
          ).bind(cursor, sent, failed, chatId).run();

          await sendMessageWithKeyboard(
            token, chatId,
            `⏸️ <b>群发暂停（时间预算用尽）</b>\n-------------------------\n` +
            `📤 已成功：<b>${sent}</b> 人\n❌ 已失败：<b>${failed}</b> 人\n\n` +
            `点击下方按钮继续发送剩余用户：`,
            {
              inline_keyboard: [
                [{ text: "▶️ 继续发送", callback_data: "admin_broadcast_continue" }]
              ]
            },
            "HTML"
          );
          return;
        }

        try {
          const res = await sendMessage(token, row.user_id, draft.content);
          if (res && res.ok) sent++;
          else failed++;
        } catch (e) {
          failed++;
        }
        cursor = Number(row.id) || cursor;
        if (BROADCAST.INTERVAL_MS > 0) await sleep(BROADCAST.INTERVAL_MS);
      }

      await env.DB.prepare(
        "UPDATE broadcast_drafts SET cursor_id = ?, sent = ?, failed = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
      ).bind(cursor, sent, failed, chatId).run();
    }
  } catch (e) {
    logError("群发任务异常：", e);
    try {
      await sendMessage(token, chatId, `❌ 群发过程中出现异常：${e.message || e}`);
    } catch (_) {
      /* 忽略 */
    }
  }
}
