// ==========================================
// 🪙 积分管理
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { logPointChange } from "../services/points.js";
import { logAdminAction } from "../services/admin-log.js";

export async function renderUserPtsMenu(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT user_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return;
  const user = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(scene.user_key).first();
  const currentPts = Number.isFinite(Number(user?.points)) ? Math.max(0, Math.floor(Number(user.points))) : 0;

  const text =
    `🪙 <b>用户全局积分管理</b>\n` +
    `-------------------------\n` +
    `🔢 <b>场景行 ID:</b> <code>${rowId}</code>\n` +
    `💰 <b>全局积分键:</b> <code>${escapeHtml(scene.user_key)}</code>\n` +
    `💵 <b>当前全局积分:</b> <b>${currentPts}</b>\n\n` +
    `点击下方按钮快速调整（影响该用户在所有场景的积分）：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "+10 积分", callback_data: `admin_modpts_${rowId}:10` },
        { text: "+50 积分", callback_data: `admin_modpts_${rowId}:50` },
        { text: "+100 积分", callback_data: `admin_modpts_${rowId}:100` }
      ],
      [
        { text: "-10 积分", callback_data: `admin_modpts_${rowId}:-10` },
        { text: "-50 积分", callback_data: `admin_modpts_${rowId}:-50` },
        { text: "清零积分", callback_data: `admin_modpts_${rowId}:-${currentPts}` }
      ],
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]
    ]
  };
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

export async function handleModPoints({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const raw = data.replace("admin_modpts_", "");
  const sepIndex = raw.indexOf(":");
  if (sepIndex === -1 || !env.DB) return;

  const rowId = parseInt(raw.substring(0, sepIndex), 10);
  const delta = parseInt(raw.substring(sepIndex + 1), 10);
  if (!Number.isInteger(rowId) || isNaN(delta)) return;

  const scene = await env.DB.prepare("SELECT user_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const user = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(scene.user_key).first();
  if (!user) {
    await answerCallback(token, callback.id, "❌ 用户不存在", true);
    return;
  }

  const cur = Number.isFinite(Number(user.points)) ? Number(user.points) : 0;
  const newPts = Math.min(1000000, Math.max(0, cur + delta));
  await env.DB.prepare("UPDATE users SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?")
    .bind(newPts, scene.user_key).run();
  const actualDelta = newPts - cur;
  await logPointChange(env, scene.user_key, actualDelta, newPts, "管理员调整");
  await logAdminAction(env, {
    adminId, chatId, action: "user_points_mod",
    detail: `${scene.user_key} ${actualDelta >= 0 ? "+" : ""}${actualDelta} → ${newPts}`
  });
  await answerCallback(token, callback.id, `✅ 全局积分已更新为 ${newPts}`);
  await renderUserPtsMenu(token, env, chatId, msgId, rowId);
}
