// ==========================================
// ⏰ 定时任务（Workers Cron Triggers）
// 1. 清理过期/陈旧数据
// 2. 给管理员推送「昨日概况 + 待处理订单」提醒
//
// 清理的对象都是「引导式输入会话 / 草稿」：
// 这些状态会拦截用户的普通消息，一旦残留就会一直吞消息，
// 所以除了处理器自身的 30 分钟有效期，定时任务还要兜底删除。
// ==========================================

import { getDateKey, shiftDateKey } from "./time.js";
import { sendMessageWithKeyboard, sendMessage } from "../telegram/api.js";
import { resolveAdminChatId } from "../shop/notify.js";
import { escapeHtml } from "../utils/html.js";
import { logError, logInfo } from "../core/logger.js";
import { expirePunishments, ACTIONS, formatDuration } from "./guard.js";
import { reindexKnowledge } from "./knowledge.js";

/**
 * 清理过期数据（引导会话、草稿、过期兑换码）。
 * @returns {Promise<object|null>} 各表清理条数；没有数据库时返回 null
 */
export async function cleanupStaleData(env) {
  if (!env.DB) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const today = getDateKey(env);

  const adminSessions = await env.DB.prepare(
    "DELETE FROM admin_sessions WHERE expires_at <= ?"
  ).bind(nowSec).run();

  const broadcastDrafts = await env.DB.prepare(
    "DELETE FROM broadcast_drafts WHERE updated_at <= datetime('now', '-7 days')"
  ).run();

  const orderDrafts = await env.DB.prepare(
    "DELETE FROM shop_order_drafts WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const addSessions = await env.DB.prepare(
    "DELETE FROM shop_add_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const editSessions = await env.DB.prepare(
    "DELETE FROM shop_edit_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const taskSessions = await env.DB.prepare(
    "DELETE FROM task_edit_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const kbSessions = await env.DB.prepare(
    "DELETE FROM kb_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const guardSessions = await env.DB.prepare(
    "DELETE FROM guard_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  // 群规处置：把已到期的临时禁言标记为 expired（返回明细，供定时任务发通知），
  // 并清理一天前仍未确认的处置记录
  const expiredList = await expirePunishments(env);
  const stalePunishments = await env.DB.prepare(
    "DELETE FROM group_punishments WHERE status = 'pending' AND created_at <= datetime('now', '-1 day')"
  ).run();
  // 已处理完的申诉保留 30 天，避免无限增长
  const staleAppeals = await env.DB.prepare(
    "DELETE FROM punishment_appeals WHERE status <> 'pending' AND created_at <= datetime('now', '-30 days')"
  ).run();

  const expiredCodes = await env.DB.prepare(
    "UPDATE redeem_codes SET enabled = 0 WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?"
  ).bind(today).run();

  return {
    adminSessions: adminSessions.meta.changes,
    broadcastDrafts: broadcastDrafts.meta.changes,
    orderDrafts: orderDrafts.meta.changes,
    addSessions: addSessions.meta.changes,
    editSessions: editSessions.meta.changes,
    taskSessions: taskSessions.meta.changes,
    kbSessions: kbSessions.meta.changes,
    guardSessions: guardSessions.meta.changes,
    expiredPunishments: expiredList.length,
    stalePunishments: stalePunishments.meta.changes,
    staleAppeals: staleAppeals.meta.changes,
    expiredCodes: expiredCodes.meta.changes,
    // 明细给定时任务用（发到期通知）；日志汇总里只记数量
    expiredList
  };
}

/**
 * 汇总昨日（按 APP_TIMEZONE）的运行数据 + 当前待处理订单。
 */
export async function collectDailySummary(env) {
  const today = getDateKey(env);
  const yesterday = shiftDateKey(today, -1);

  if (!env.DB) {
    return { today, yesterday, activeScenes: 0, messages: 0, checkins: 0, pendingOrders: 0, pendingList: [], blocked: 0, redeems24h: 0 };
  }

  const [activeRes, msgRes, checkinRes, pendingRes, pendingListRes, blockedRes, redeemRes] = await Promise.all([
    env.DB.prepare("SELECT COUNT(DISTINCT scene_key) AS n FROM daily_stats WHERE date_str = ? AND count > 0").bind(yesterday).first(),
    env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_stats WHERE date_str = ?").bind(yesterday).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM daily_checkin WHERE date_str = ?").bind(yesterday).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'pending'").first(),
    env.DB.prepare(
      "SELECT order_no, item_name, price, created_at FROM shop_orders WHERE status = 'pending' ORDER BY id ASC LIMIT 5"
    ).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(blocked, 0) = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM redeem_logs WHERE created_at >= datetime('now', '-1 day')").first()
  ]);

  return {
    today,
    yesterday,
    activeScenes: Number(activeRes?.n) || 0,
    messages: Number(msgRes?.n) || 0,
    checkins: Number(checkinRes?.n) || 0,
    pendingOrders: Number(pendingRes?.n) || 0,
    pendingList: pendingListRes?.results || [],
    blocked: Number(blockedRes?.n) || 0,
    redeems24h: Number(redeemRes?.n) || 0
  };
}

/**
 * 定时任务总入口：清理 → 汇总 → 给管理员推送概况（未配置管理员时只清理）。
 */
export async function runScheduledTasks(env, token) {
  const cleanup = await cleanupStaleData(env);
  const summary = await collectDailySummary(env);

  // 索引维护：补上「上传时没有 AI」或「换过向量模型」的分块（每次有上限，分多次跑完）
  let reindex = null;
  if (env?.AI && env?.DB) {
    reindex = await reindexKnowledge(env, { limit: 20 });
  }

  // expiredList 只用于发通知，日志里只保留数量
  const { expiredList = [], ...cleanupCounts } = cleanup || {};
  logInfo("定时任务完成：", JSON.stringify({
    cleanup: cleanupCounts,
    reindex,
    summary: { ...summary, pendingList: summary.pendingList.length }
  }));

  // 到期通知：限时禁言/封禁由 Telegram 自动解除，这里补一条公告 + 私聊当事人
  if (token && expiredList.length > 0) {
    await notifyExpiredPunishments(token, expiredList);
  }

  const adminChat = resolveAdminChatId(env);
  if (!token || !adminChat) return { cleanup: cleanupCounts, summary, reindex, notified: false };

  const lines = [];
  lines.push(`🌙 <b>每日概况</b> · ${summary.yesterday}`);
  lines.push("-------------------------");
  lines.push(`🟢 <b>昨日活跃场景：</b> ${summary.activeScenes}`);
  lines.push(`💬 <b>昨日消息量：</b> ${summary.messages}`);
  lines.push(`📅 <b>昨日签到人数：</b> ${summary.checkins}`);
  lines.push(`🎟️ <b>近 24h 兑换码使用：</b> ${summary.redeems24h}`);
  lines.push(`🚫 <b>当前封禁用户：</b> ${summary.blocked}`);
  lines.push(`⏳ <b>待处理订单：</b> <b>${summary.pendingOrders}</b>`);
  if (expiredList.length > 0) {
    lines.push(`⌛ <b>刚到期处置：</b> ${expiredList.length} 条（已自动解除并通知）`);
  }

  if (summary.pendingList.length > 0) {
    lines.push("");
    lines.push("📦 <b>最早的几笔待处理：</b>");
    for (const order of summary.pendingList) {
      lines.push(`• <code>${escapeHtml(order.order_no)}</code> ${escapeHtml(order.item_name)} · 🪙 ${order.price}`);
    }
  }

  if (cleanup) {
    const cleaned = Object.values(cleanupCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    if (cleaned > 0) {
      lines.push("");
      lines.push(`🧹 <b>本次清理：</b> ${cleaned} 条（过期会话/草稿/兑换码）`);
    }
  }

  if (reindex?.ok && reindex.updated > 0) {
    lines.push(`🧠 <b>知识库索引：</b> 本次重建 ${reindex.updated} 块，剩余 ${reindex.remaining} 块`);
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: `⏳ 待处理订单（${summary.pendingOrders}）`, callback_data: "shop_admin_orders_pending_1" }],
      [{ text: "👑 打开管理控制台", callback_data: "admin_main_menu" }]
    ]
  };

  try {
    await sendMessageWithKeyboard(token, adminChat, lines.join("\n"), keyboard, "HTML");
    return { cleanup: cleanupCounts, summary, reindex, notified: true };
  } catch (e) {
    logError("发送每日概况失败：", e);
    return { cleanup: cleanupCounts, summary, reindex, notified: false };
  }
}

/**
 * 临时处置到期的通知：群里公告一句，同时私聊当事人。
 * 单个失败不影响其它记录。
 */
async function notifyExpiredPunishments(token, rows) {
  for (const row of rows) {
    const action = ACTIONS[row.action]?.short || row.action;
    const name = row.user_label || row.user_id;
    try {
      await sendMessage(
        token, row.chat_id,
        `⌛ <b>处置已到期</b>\n-------------------------\n` +
        `👤 ${escapeHtml(name)} 的${action}（${formatDuration(row.duration_min)}）已自动解除。`,
        "HTML"
      );
    } catch (e) {
      logError("发送处置到期公告失败：", e);
    }
    try {
      await sendMessage(
        token, row.user_id,
        `⌛ 你在群 <code>${escapeHtml(row.chat_id)}</code> 的${action}已到期，限制已解除。`,
        "HTML"
      );
    } catch { /* 用户没私聊过机器人，忽略 */ }
  }
}
