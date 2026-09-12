// ==========================================
// ⏰ 定时任务（Workers Cron Triggers）
// 1. 清理过期/陈旧数据
// 2. 给管理员推送「昨日概况 + 待处理订单」提醒
// ==========================================

import { getDateKey, shiftDateKey } from "./time.js";
import { sendMessageWithKeyboard } from "../telegram/api.js";
import { resolveAdminChatId } from "../shop/notify.js";
import { escapeHtml } from "../utils/html.js";
import { logError, logInfo } from "../core/logger.js";

/**
 * 清理过期数据。返回各表清理条数，便于日志与测试。
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

  const expiredCodes = await env.DB.prepare(
    "UPDATE redeem_codes SET enabled = 0 WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?"
  ).bind(today).run();

  return {
    adminSessions: adminSessions.meta.changes,
    broadcastDrafts: broadcastDrafts.meta.changes,
    orderDrafts: orderDrafts.meta.changes,
    addSessions: addSessions.meta.changes,
    editSessions: editSessions.meta.changes,
    expiredCodes: expiredCodes.meta.changes
  };
}

/**
 * 汇总昨日（按 APP_TIMEZONE）的运行数据。
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
 * 定时任务总入口：清理 + 推送概况。
 */
export async function runScheduledTasks(env, token) {
  const cleanup = await cleanupStaleData(env);
  const summary = await collectDailySummary(env);

  logInfo("定时任务完成：", JSON.stringify({ cleanup, summary: { ...summary, pendingList: summary.pendingList.length } }));

  const adminChat = resolveAdminChatId(env);
  if (!token || !adminChat) return { cleanup, summary, notified: false };

  const lines = [];
  lines.push(`🌙 <b>每日概况</b> · ${summary.yesterday}`);
  lines.push(`-------------------------`);
  lines.push(`🟢 <b>昨日活跃场景：</b> ${summary.activeScenes}`);
  lines.push(`💬 <b>昨日消息量：</b> ${summary.messages}`);
  lines.push(`📅 <b>昨日签到人数：</b> ${summary.checkins}`);
  lines.push(`🎟️ <b>近 24h 兑换码使用：</b> ${summary.redeems24h}`);
  lines.push(`🚫 <b>当前封禁用户：</b> ${summary.blocked}`);
  lines.push(`⏳ <b>待处理订单：</b> <b>${summary.pendingOrders}</b>`);

  if (summary.pendingList.length > 0) {
    lines.push("");
    lines.push("📦 <b>最早的几笔待处理：</b>");
    for (const order of summary.pendingList) {
      lines.push(`• <code>${escapeHtml(order.order_no)}</code> ${escapeHtml(order.item_name)} · 🪙 ${order.price}`);
    }
  }

  if (cleanup) {
    const cleaned = Object.values(cleanup).reduce((sum, n) => sum + (Number(n) || 0), 0);
    if (cleaned > 0) {
      lines.push("");
      lines.push(`🧹 <b>本次清理：</b> ${cleaned} 条（过期会话/草稿/兑换码）`);
    }
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: `⏳ 待处理订单（${summary.pendingOrders}）`, callback_data: "shop_admin_orders_pending_1" }],
      [{ text: "👑 打开管理控制台", callback_data: "admin_main_menu" }]
    ]
  };

  try {
    await sendMessageWithKeyboard(token, adminChat, lines.join("\n"), keyboard, "HTML");
    return { cleanup, summary, notified: true };
  } catch (e) {
    logError("发送每日概况失败：", e);
    return { cleanup, summary, notified: false };
  }
}
