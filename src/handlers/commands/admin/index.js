// ==========================================
// 👑 管理员指令分发
// ==========================================

import { sendAutoDelete } from "../../../telegram/auto-delete.js";
import { sendAdminMainMenu } from "../../../admin/menus.js";
import { renderUserListMenu } from "../../../admin/user-list.js";
import { sendAdminStatsMessage } from "../../../admin/stats.js";
import { logPointChange } from "../../../services/points.js";
import { ERR } from "../../../config/messages.js";
import { RULES } from "../../../config/constants.js";

async function checkAdminUnlocked(env, isMaster, chatId) {
  if (!isMaster) return false;
  if (!env.DB) return true;
  const now = Math.floor(Date.now() / 1000);
  const s = await env.DB.prepare("SELECT expires_at FROM admin_sessions WHERE chat_id = ?").bind(chatId).first();
  return Boolean(s && s.expires_at > now);
}

// ---------- /admin ----------
export async function cmdAdminRoot({ env, ctx, token, chatId, isMaster, isGroupCtx }) {
  if (!isMaster) {
    await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, ctx);
    return;
  }
  if (env.DB) {
    const expiresAt = Math.floor(Date.now() / 1000) + RULES.ADMIN_SESSION_SEC;
    await env.DB.prepare(
      "INSERT INTO admin_sessions (chat_id, expires_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET expires_at = EXCLUDED.expires_at"
    ).bind(chatId, expiresAt).run();
  }
  // 群聊里不显示商城入口
  await sendAdminMainMenu(token, chatId, !isGroupCtx);
}

// ---------- /users ----------
export async function cmdUsersPrivate({ env, ctx, token, chatId, isMaster, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await renderUserListMenu(token, env, chatId, null, 1, "private");
}

// ---------- /users_group ----------
export async function cmdUsersGroup({ env, ctx, token, chatId, isMaster, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await renderUserListMenu(token, env, chatId, null, 1, "group");
}

// ---------- /stats ----------
export async function cmdStats({ env, ctx, token, chatId, isMaster, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await sendAdminStatsMessage(token, env, chatId);
}

// ---------- /addpoints ----------
export async function cmdAddPoints({ env, ctx, token, chatId, isMaster, isGroupCtx, rawText }) {
  if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  const parts = rawText.split(/\s+/);
  if (parts.length < 3) {
    await sendAutoDelete(token, chatId, "⚠️ 格式：/addpoints <场景行ID> <数量>", null, isGroupCtx, ctx);
    return;
  }
  const rowId = parseInt(parts[1].trim(), 10);
  const delta = parseInt(parts[2].trim(), 10);
  if (!Number.isInteger(rowId) || isNaN(delta) || !env.DB) {
    await sendAutoDelete(token, chatId, "⚠️ 参数无效或数据库未绑定。", null, isGroupCtx, ctx);
    return;
  }
  const scene = await env.DB.prepare("SELECT user_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) {
    await sendAutoDelete(token, chatId, `❌ 未找到场景 #${rowId}`, null, isGroupCtx, ctx);
    return;
  }
  const u = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(scene.user_key).first();
  const cur = Number.isFinite(Number(u?.points)) ? Number(u.points) : 0;
  const newPts = Math.max(0, Math.floor(cur + delta));
  await env.DB.prepare("UPDATE users SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ?")
    .bind(newPts, scene.user_key).run();
  const actualDelta = newPts - cur;
  await logPointChange(env, scene.user_key, actualDelta, newPts, "管理员命令调整");
  await sendAutoDelete(token, chatId, `✅ 已更新用户全局积分: ${newPts}`, null, isGroupCtx, ctx);
}
