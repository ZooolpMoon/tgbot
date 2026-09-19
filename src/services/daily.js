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
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { getSetting, setSetting } from "./settings.js";
import { resolveAdminChatId } from "../shop/notify.js";
import { escapeHtml } from "../utils/html.js";
import { logError, logInfo } from "../core/logger.js";
import { expirePunishments, ACTIONS, formatDuration } from "./guard.js";
import { reindexKnowledge } from "./knowledge.js";
import { ensureWebhook } from "./webhook.js";
import { refundPoint } from "./points.js";
import { deleteMessage } from "../telegram/api.js";

/**
 * 「每天一次」的 cron 表达式（默认 16:00 UTC = 北京 00:00）。
 * 只有它负责推送每日概况——每 2 分钟的那条是给「长延时自动删除」做兜底的，
 * 如果不区分，概况就会每 2 分钟弹一次。
 */
export const DAILY_SUMMARY_CRON = "0 16 * * *";

/** 记录「哪一天已经推过概况」的全局设置键，同一天再触发也不重复推 */
const SUMMARY_MARK_KEY = "daily.last_summary_date";

/**
 * 定时推送也可能发到群里（`ADMIN_NOTIFY_CHAT_ID` 配置成群时），
 * 这里按目标会话套用「系统通知」的自动删除设置；私聊保持不删。
 */
function deliverPush({ token, env, ctx = null, chatId, text, keyboard = null }) {
  const isGroup = String(chatId || "").startsWith("-");
  return sendAutoDelete(token, chatId, text, "HTML", isGroup, ctx, {
    kind: "notice",
    env,
    sceneKey: isGroup ? `group:${chatId}` : null,
    keyboard
  });
}

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

  const kbSessions = await env.DB.prepare(
    "DELETE FROM kb_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const guardSessions = await env.DB.prepare(
    "DELETE FROM guard_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  const adminManageSessions = await env.DB.prepare(
    "DELETE FROM admin_manage_sessions WHERE updated_at <= datetime('now', '-1 day')"
  ).run();

  // 群标签引导流程（选群 → 填标签）也是 30 分钟有效，这里兜底
  const tagSessions = await env.DB.prepare(
    "DELETE FROM group_tag_sessions WHERE updated_at <= datetime('now', '-1 day')"
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

  // 21 点牌局超时：**先退还本金再删记录** —— 本金是开局就扣掉的，
  // 用户没点完（或干脆忘了）不能算他输，否则等于机器人吞分。
  let blackjackRefunded = 0;
  let blackjackFailed = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT user_key, bet FROM blackjack_sessions
        WHERE status = 'playing' AND updated_at <= datetime('now', '-30 minutes')`
    ).all();
    for (const row of results || []) {
      const bet = Math.floor(Number(row.bet) || 0);
      if (bet < 1) continue;
      const refunded = await refundPoint(env, row.user_key, bet, "21 点牌局超时退款");
      if (refunded === null) blackjackFailed++;
      else blackjackRefunded++;
    }
  } catch (e) {
    logError("21 点超时退款失败：", e);
  }
  const blackjackSessions = await env.DB.prepare(
    `DELETE FROM blackjack_sessions
      WHERE updated_at <= datetime('now', '-30 minutes')`
  ).run();

  return {
    adminSessions: adminSessions.meta.changes,
    broadcastDrafts: broadcastDrafts.meta.changes,
    orderDrafts: orderDrafts.meta.changes,
    addSessions: addSessions.meta.changes,
    editSessions: editSessions.meta.changes,
    kbSessions: kbSessions.meta.changes,
    guardSessions: guardSessions.meta.changes,
    adminManageSessions: adminManageSessions.meta.changes,
    tagSessions: tagSessions.meta.changes,
    blackjackSessions: blackjackSessions.meta.changes,
    blackjackRefunded,
    blackjackFailed,
    expiredPunishments: expiredList.length,
    stalePunishments: stalePunishments.meta.changes,
    staleAppeals: staleAppeals.meta.changes,
    expiredCodes: expiredCodes.meta.changes,
    // 明细给定时任务用（发到期通知）；日志汇总里只记数量
    expiredList
  };
}

/**
 * 处理「长延时自动删除」：把到点的机器人消息删掉。
 *
 * 为什么不在发送时 sleep：Worker 的 waitUntil 撑不住几十分钟（30/60 分钟）。
 * 所以发送时只登记一条 pending_deletes，由定时任务（每 2 分钟）扫描执行。
 * 单次最多删 30 条，避免一次跑太久；Telegram 侧删除失败（超过 48 小时 / 已删除）直接清掉记录。
 *
 * @returns {Promise<{deleted:number, failed:number, purged:number}>}
 */
export async function processPendingDeletes(env, token, { limit = 30 } = {}) {
  if (!env?.DB || !token) return { deleted: 0, failed: 0, purged: 0 };
  const nowSec = Math.floor(Date.now() / 1000);

  // 超过 48 小时的消息 Telegram 已经不允许删除，直接清掉记录
  const purgedRes = await env.DB.prepare(
    "DELETE FROM pending_deletes WHERE delete_at <= ?"
  ).bind(nowSec - 48 * 3600).run();

  const { results } = await env.DB.prepare(
    "SELECT id, chat_id, message_id FROM pending_deletes WHERE delete_at <= ? ORDER BY id ASC LIMIT ?"
  ).bind(nowSec, Math.max(1, Math.floor(limit) || 30)).all();

  const rows = results || [];
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const res = await deleteMessage(token, row.chat_id, row.message_id);
      if (res && res.ok === false) failed++;
      else deleted++;
    } catch (e) {
      failed++;
      logError("删除待删消息失败：", e);
    }
    // 无论成功失败都清掉记录：失败多半是「消息已被删 / 太久」，重试没有意义
    await env.DB.prepare("DELETE FROM pending_deletes WHERE id = ?").bind(row.id).run();
  }

  return { deleted, failed, purged: Number(purgedRes?.meta?.changes) || 0 };
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
 *
 * @param {object} env
 * @param {string} token
 * @param {object} [ctx] Workers ExecutionContext
 * @param {{cron?:string|null}} [options] cron = 本次触发的 cron 表达式（见 DAILY_SUMMARY_CRON）
 */
export async function runScheduledTasks(env, token, ctx = null, { cron = null } = {}) {
  // 先处理「长延时自动删除」（每 2 分钟的 cron 会频繁跑这一条；开销很小）
  let pendingDeletes = null;
  if (token && env?.DB) {
    try {
      pendingDeletes = await processPendingDeletes(env, token);
    } catch (e) {
      logError("处理待删除消息失败：", e);
    }
  }

  const cleanup = await cleanupStaleData(env);
  const summary = await collectDailySummary(env);

  // webhook 自愈巡检：Telegram 侧地址被清空时自己补回来（isolate 内每 10 分钟最多查一次）
  let webhook = null;
  if (token && env?.DB) {
    try {
      webhook = await ensureWebhook(env, token);
    } catch (e) {
      logError("webhook 巡检失败：", e);
    }
  }

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
    pendingDeletes,
    webhook,
    summary: { ...summary, pendingList: summary.pendingList.length }
  }));

  // 到期通知：限时禁言/封禁由 Telegram 自动解除，这里补一条公告 + 私聊当事人
  if (token && expiredList.length > 0) {
    await notifyExpiredPunishments(token, expiredList, env, ctx);
  }

  const adminChat = resolveAdminChatId(env);
  if (!token || !adminChat) return { cleanup: cleanupCounts, summary, reindex, notified: false };

  // 每日概况不是每次都推：只有「每天一次」的 cron 负责推送，否则每 2 分钟就弹一次。
  const isDailyRun = !cron || cron === DAILY_SUMMARY_CRON;
  if (!isDailyRun) {
    logInfo("跳过每日概况（非日报时段）：", cron);
    return { cleanup: cleanupCounts, summary, reindex, notified: false, skipped: "非日报时段" };
  }
  // 同一天再触发也不重复推（多配/改配 cron 时的兜底）
  if ((await getSetting(env, SUMMARY_MARK_KEY, "")) === summary.today) {
    logInfo("跳过每日概况（今日已推送）：", summary.today);
    return { cleanup: cleanupCounts, summary, reindex, notified: false, skipped: "今日已推送" };
  }

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
    await deliverPush({
      token, env, ctx, chatId: adminChat, text: lines.join("\n"), keyboard
    });
    // 记录标记放在「发送成功之后」：发失败就不标记，下次日报时段还能再试
    await setSetting(env, SUMMARY_MARK_KEY, summary.today);
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
async function notifyExpiredPunishments(token, rows, env = null, ctx = null) {
  for (const row of rows) {
    const action = ACTIONS[row.action]?.short || row.action;
    const name = row.user_label || row.user_id;
    try {
      await deliverPush({
        token, env, ctx, chatId: row.chat_id,
        text:
          `⌛ <b>处置已到期</b>\n-------------------------\n` +
          `👤 ${escapeHtml(name)} 的${action}（${formatDuration(row.duration_min)}）已自动解除。`
      });
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
