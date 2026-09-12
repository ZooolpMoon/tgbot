// ==========================================
// 🪙 积分管理
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid } from "../utils/layout.js";
import { logPointChange } from "../services/points.js";
import { logAdminAction } from "../services/admin-log.js";

/**
 * 积分调整键盘（纯函数，便于排版测试）。
 * 快捷按钮按两列网格排列，"清零" 用当前积分的相反数实现。
 * @param {number} rowId 场景行 ID
 * @param {number} currentPts 当前全局积分
 */
export function getUserPointsKeyboard(rowId, currentPts) {
  const pts = Math.max(0, Math.floor(Number(currentPts) || 0));
  return {
    inline_keyboard: [
      ...grid([
        { text: "+10 积分", callback_data: `admin_modpts_${rowId}:10` },
        { text: "+50 积分", callback_data: `admin_modpts_${rowId}:50` },
        { text: "+100 积分", callback_data: `admin_modpts_${rowId}:100` },
        { text: "-10 积分", callback_data: `admin_modpts_${rowId}:-10` },
        { text: "-50 积分", callback_data: `admin_modpts_${rowId}:-50` },
        { text: "清零积分", callback_data: `admin_modpts_${rowId}:-${pts}` }
      ]),
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]
    ]
  };
}

/** 渲染某个场景的积分管理面板 */
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

  return editMessageText(token, chatId, messageId, text, getUserPointsKeyboard(rowId, currentPts), "HTML");
}

/**
 * 处理积分增减回调。
 * 积分为 0 ~ 1000000 之间的整数，超出部分自动截断（扣减同样不会变成负数）。
 */
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
  // 原子夹断更新：即使并发调整，落库结果也始终在 0 ~ 1000000 之间
  const updated = await env.DB.prepare(
    "UPDATE users SET points = MAX(0, MIN(1000000, points + ?)), updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(delta, scene.user_key).first();
  if (!updated) {
    await answerCallback(token, callback.id, "❌ 用户不存在", true);
    return;
  }
  const newPts = Number(updated.points);
  const actualDelta = newPts - cur;
  await logPointChange(env, scene.user_key, actualDelta, newPts, "管理员调整");
  await logAdminAction(env, {
    adminId, chatId, action: "user_points_mod",
    detail: `${scene.user_key} ${actualDelta >= 0 ? "+" : ""}${actualDelta} → ${newPts}`
  });
  await answerCallback(token, callback.id, `✅ 全局积分已更新为 ${newPts}`);
  await renderUserPtsMenu(token, env, chatId, msgId, rowId);
}
