// ==========================================
// 👑 管理员指令分发
// 所有管理指令都要求「是管理员 + 已 /admin 解锁」，
// 解锁状态存 admin_sessions，30 分钟无操作自动失效。
// ==========================================

import { sendAutoDelete } from "../../../telegram/auto-delete.js";
import { sendAdminMainMenu } from "../../../admin/menus.js";
import { renderUserListMenu } from "../../../admin/user-list.js";
import { sendAdminStatsMessage } from "../../../admin/stats.js";
import { logPointChange } from "../../../services/points.js";
import { resolvePointTarget } from "../../../services/users.js";
import { ERR } from "../../../config/messages.js";
import { RULES } from "../../../config/constants.js";

/**
 * 后台是否已解锁（没有数据库时视为已解锁，方便本地调试）。
 * 只对「后台角色」（owner / admin）有意义——执法员与本群管理员不走这个会话。
 */
export async function checkAdminUnlocked(env, chatId) {
  if (!env.DB) return true;
  const now = Math.floor(Date.now() / 1000);
  const s = await env.DB.prepare("SELECT expires_at FROM admin_sessions WHERE chat_id = ?").bind(chatId).first();
  return Boolean(s && s.expires_at > now);
}

// ---------- /admin ----------
/** /admin：解锁并打开管理控制台 */
export async function cmdAdminRoot({ env, ctx, token, chatId, isGroupCtx, role }) {
  if (env.DB) {
    const expiresAt = Math.floor(Date.now() / 1000) + RULES.ADMIN_SESSION_SEC;
    await env.DB.prepare(
      "INSERT INTO admin_sessions (chat_id, expires_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET expires_at = EXCLUDED.expires_at"
    ).bind(chatId, expiresAt).run();
  }
  // 群聊里不显示商城入口
  await sendAdminMainMenu(token, chatId, !isGroupCtx, role || "owner");
}

// ---------- /admins ----------
/** /admins：打开「管理员与权限」面板（只有拥有者具备该能力） */
export async function cmdAdmins({ env, token, chatId, role }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, false);
    return;
  }
  const { renderAdminsPanel } = await import("../../../admin/admins.js");
  await renderAdminsPanel(token, env, chatId, null);
}

// ---------- /users ----------
/** /users：私聊场景列表 */
export async function cmdUsersPrivate({ env, ctx, token, chatId, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await renderUserListMenu(token, env, chatId, null, 1, "private");
}

// ---------- /users_group ----------
/** /users_group：群聊场景列表 */
export async function cmdUsersGroup({ env, ctx, token, chatId, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await renderUserListMenu(token, env, chatId, null, 1, "group");
}

// ---------- /stats ----------
/** /stats：以新消息发送系统统计 */
export async function cmdStats({ env, ctx, token, chatId, isGroupCtx }) {
  if (!(await checkAdminUnlocked(env, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  await sendAdminStatsMessage(token, env, chatId);
}

// ---------- /addpoints ----------
/**
 * /addpoints <场景行ID> <数量>：按场景行找到背后的用户，调整其全局积分。
 * 数量可正可负，结果收敛到 0 以上。
 */
export async function cmdAddPoints({ env, ctx, token, chatId, isGroupCtx, rawText }) {
  if (!(await checkAdminUnlocked(env, chatId))) {
    await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
    return;
  }
  const parts = String(rawText || "").split(/\s+/);
  if (parts.length < 3) {
    await sendAutoDelete(
      token, chatId,
      "⚠️ 格式：<code>/addpoints &lt;场景ID|用户ID|@用户名&gt; &lt;数量&gt;</code>\n" +
      "例如：<code>/addpoints 12 100</code>、<code>/addpoints 8802544525 100</code>、<code>/addpoints @someone 100</code>",
      "HTML", isGroupCtx, ctx
    );
    return;
  }
  const delta = parseInt(parts[2].trim(), 10);
  if (!Number.isInteger(delta)) {
    await sendAutoDelete(token, chatId, "⚠️ 数量必须是整数（可以是负数表示扣分）。", "HTML", isGroupCtx, ctx);
    return;
  }

  // 目标写法很杂（场景行 ID / 用户 ID / @用户名），统一交给解析器，失败时给出可照抄的写法
  const target = await resolvePointTarget(env, parts[1]);
  if (!target.ok) {
    await sendAutoDelete(
      token, chatId,
      `⚠️ ${target.error}${target.extra ? `\n\n${target.extra}` : ""}`,
      "HTML", isGroupCtx, ctx
    );
    return;
  }
  const userKey = target.userKey;

  const u = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(userKey).first();
  const cur = Number.isFinite(Number(u?.points)) ? Number(u.points) : 0;
  // 原子夹断更新：结果始终落在 0 ~ 1000000 之间（与积分管理面板保持一致）
  const updated = await env.DB.prepare(
    "UPDATE users SET points = MAX(0, MIN(1000000, points + ?)), updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(Math.floor(delta), userKey).first();
  if (!updated) {
    await sendAutoDelete(token, chatId, "❌ 用户不存在", null, isGroupCtx, ctx);
    return;
  }
  const newPts = Number(updated.points);
  const actualDelta = newPts - cur;
  await logPointChange(env, userKey, actualDelta, newPts, "管理员命令调整");

  // 夹断时说清楚：请求 9999999 只会落到上限 1000000，免得以为没生效
  const clamped = actualDelta !== Math.floor(delta);
  const sign = actualDelta >= 0 ? "+" : "";
  await sendAutoDelete(
    token, chatId,
    `✅ <b>${target.how}</b> 的全局积分：<b>${newPts}</b>（本次 ${sign}${actualDelta}）` +
    (clamped ? "\n⚠️ 已按上限 0 ~ 1000000 夹断。" : ""),
    "HTML", isGroupCtx, ctx
  );
}
