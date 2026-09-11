// ==========================================
// ⏱️ 发送频率
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";

export async function renderUserRateMenu(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT scene_key, rate_limit_sec FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return;
  const currentRate = Number.isFinite(Number(scene.rate_limit_sec)) ? Math.max(0, Math.floor(Number(scene.rate_limit_sec))) : 5;

  const text =
    `⏱️ <b>场景发送频率设置</b>\n` +
    `-------------------------\n` +
    `🔢 <b>场景行 ID:</b> <code>${rowId}</code>\n` +
    `🧩 <b>场景键:</b> <code>${escapeHtml(scene.scene_key)}</code>\n` +
    `⏳ <b>当前冷却间隔:</b> ${currentRate} 秒/条\n\n` +
    `只影响该场景：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "无限制 (0秒)", callback_data: `admin_setrate_${rowId}_0` },
        { text: "3 秒", callback_data: `admin_setrate_${rowId}_3` },
        { text: "5 秒", callback_data: `admin_setrate_${rowId}_5` }
      ],
      [
        { text: "10 秒", callback_data: `admin_setrate_${rowId}_10` },
        { text: "30 秒", callback_data: `admin_setrate_${rowId}_30` },
        { text: "60 秒", callback_data: `admin_setrate_${rowId}_60` }
      ],
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]
    ]
  };
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

export async function handleSetRate({ env, token, callback, chatId, msgId, data }) {
  const raw = data.replace("admin_setrate_", "");
  const sepIndex = raw.indexOf("_");
  const rowId = parseInt(sepIndex === -1 ? raw : raw.substring(0, sepIndex), 10);
  const rateValue = sepIndex === -1 ? "" : raw.substring(sepIndex + 1);
  const sec = Number.parseInt(rateValue, 10);

  if (!env.DB || !Number.isInteger(rowId)) return;
  if (!Number.isInteger(sec) || sec < 0) {
    await answerCallback(token, callback.id, "❌ 无效的冷却时间参数", true);
    await renderUserRateMenu(token, env, chatId, msgId, rowId);
    return;
  }

  await env.DB.prepare("UPDATE user_scenes SET rate_limit_sec = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(sec, rowId).run();
  await answerCallback(token, callback.id, `✅ 冷却时间设置为: ${sec} 秒`);
  await renderUserRateMenu(token, env, chatId, msgId, rowId);
}