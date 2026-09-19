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
import { processJoinVerifications } from "./welcome.js";
import { cleanupAutoMod } from "./automod.js";
import { pushDailyReports, cleanupGroupMessages } from "./summary.js";
import { processDueDraws } from "./draw.js";
import { countUsage, METRIC, cleanupUsage } from "./usage.js";
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

  // 这些清理彼此独立，合并成**一次** env.DB.batch：原先 13 条串行 await
  // 就是 13 个 D1 往返，而这段每天都要跑一次。batch 按顺序执行，
  // 返回结果的顺序与传入一致，下面按位解构。
  const [
    adminSessions, broadcastDrafts, orderDrafts, addSessions, editSessions,
    kbSessions, guardSessions, adminManageSessions, tagSessions, welcomeSessions,
    stalePunishments, stuckPunishments, staleAppeals, expiredCodes
  ] = await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(nowSec),
    env.DB.prepare("DELETE FROM broadcast_drafts WHERE updated_at <= datetime('now', '-7 days')"),
    env.DB.prepare("DELETE FROM shop_order_drafts WHERE updated_at <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM shop_add_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM shop_edit_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM kb_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM guard_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM admin_manage_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    // 群标签引导流程（选群 → 填标签）也是 30 分钟有效，这里兜底
    env.DB.prepare("DELETE FROM group_tag_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    // 欢迎语编辑会话（v3.9.0）同样 30 分钟有效
    env.DB.prepare("DELETE FROM welcome_sessions WHERE updated_at <= datetime('now', '-1 day')"),
    // 清理一天前仍未确认的处置记录
    env.DB.prepare("DELETE FROM group_punishments WHERE status = 'pending' AND created_at <= datetime('now', '-1 day')"),
    // 执行中断的处置（Worker 在「原子占用」与「写回结果」之间被杀）：
    // 30 分钟后标记为 failed，避免记录永久卡在 executing。保持「失败不可重试」
    // 的现有语义 —— 宁可让管理员重新发起，也不要冒「重复执法」的风险。
    env.DB.prepare(
      `UPDATE group_punishments SET status = 'failed', detail = '执行中断（未完成）', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'executing' AND updated_at <= datetime('now', '-30 minutes')`
    ),
    // 已处理完的申诉保留 30 天，避免无限增长
    env.DB.prepare("DELETE FROM punishment_appeals WHERE status <> 'pending' AND created_at <= datetime('now', '-30 days')"),
    env.DB.prepare(
      "UPDATE redeem_codes SET enabled = 0 WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?"
    ).bind(today)
  ]);

  // 群规处置：把已到期的临时禁言标记为 expired（返回明细，供定时任务发通知）
  const expiredList = await expirePunishments(env);

  // 群内抽奖：结束（已开奖 / 已取消）的记录留 30 天，报名名单随抽奖一起清。
  // 必须**先删名单再删抽奖**：名单是按 draw_id 关联的，反过来会变成孤儿数据。
  try {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM group_draw_entries WHERE draw_id IN (SELECT id FROM group_draws WHERE status <> 'open' AND created_at <= datetime('now', '-30 days'))"
      ),
      env.DB.prepare(
        "DELETE FROM group_draws WHERE status <> 'open' AND created_at <= datetime('now', '-30 days')"
      )
    ]);
  } catch (e) {
    logError("清理抽奖记录失败：", e);
  }

  // 21 点牌局超时退款（及时型，抽出去了，见 cleanupTimely）
  const blackjack = await refundStaleBlackjack(env);

  // 自动反垃圾的历史记录（30 天）与新成员时间（7 天）。
  // 属于「日级」维护：没人会指望违规记录在 2 分钟里被清掉。
  let automod = { events: 0, newcomers: 0 };
  try {
    automod = await cleanupAutoMod(env);
  } catch (e) {
    logError("清理反垃圾记录失败：", e);
  }

  // 群消息流水（7 天）与群报正文（30 天）
  let groupLog = { messages: 0, reports: 0 };
  try {
    groupLog = await cleanupGroupMessages(env);
  } catch (e) {
    logError("清理群消息流水失败：", e);
  }

  // 用量统计明细（保留 90 天）
  let usageCleaned = 0;
  try {
    usageCleaned = await cleanupUsage(env);
  } catch (e) {
    logError("清理用量统计失败：", e);
  }

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
    welcomeSessions: welcomeSessions.meta.changes,
    // 展平成数字：上面的「本次清理」求和直接遍历这一层
    automodEvents: automod.events,
    newcomers: automod.newcomers,
    groupMessages: groupLog.messages,
    groupReports: groupLog.reports,
    usageStats: usageCleaned,
    ...blackjack,
    expiredPunishments: expiredList.length,
    stalePunishments: stalePunishments.meta.changes,
    stuckPunishments: stuckPunishments.meta.changes,
    staleAppeals: staleAppeals.meta.changes,
    expiredCodes: expiredCodes.meta.changes,
    // 明细给定时任务用（发到期通知）；日志汇总里只记数量
    expiredList
  };
}

/**
 * 21 点牌局超时退款（**及时型**：本金 30 分钟就该退回去，不能等到日报）。
 * 先退本金再删记录 —— 本金是开局就扣的，用户没点完不能算他输。
 *
 * ⚠️ 只删「退款成功 / 本来就没本金」的行：退款失败（D1 抖动、用户记录缺失）
 * 就把牌局留着，下一个 tick 再试。原先是无条件 DELETE，一次退款失败
 * 这笔本金就永远找不回来了。
 * @returns {Promise<{blackjackSessions:number, blackjackRefunded:number, blackjackFailed:number}>}
 */
async function refundStaleBlackjack(env) {
  let refundedCount = 0;
  let failed = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT chat_id, user_key, bet FROM blackjack_sessions
        WHERE status = 'playing' AND updated_at <= datetime('now', '-30 minutes')`
    ).all();

    // 牌局表是 (chat_id, user_key) 复合主键，没有自增 id，按主键定位
    const settled = [];
    for (const row of results || []) {
      const bet = Math.floor(Number(row.bet) || 0);
      if (bet < 1) {
        // 没有本金可退（理论上不该出现），直接清理
        settled.push(row);
        continue;
      }
      const refunded = await refundPoint(env, row.user_key, bet, "21 点牌局超时退款");
      if (refunded === null) {
        failed++;
        continue;   // 留着下次重试
      }
      refundedCount++;
      settled.push(row);
    }

    if (settled.length > 0) {
      await env.DB.batch(settled.map((row) =>
        env.DB.prepare("DELETE FROM blackjack_sessions WHERE chat_id = ? AND user_key = ?")
          .bind(row.chat_id, row.user_key)
      ));
    }

    return {
      blackjackSessions: settled.length,
      blackjackRefunded: refundedCount,
      blackjackFailed: failed
    };
  } catch (e) {
    logError("21 点超时退款失败（记录保留，下个 tick 重试）：", e);
    return { blackjackSessions: 0, blackjackRefunded: refundedCount, blackjackFailed: failed };
  }
}

/**
 * 及时型清理：**每 2 分钟的 cron 都要跑**的那部分。
 *
 * 为什么单独拆出来（v3.7.0）：原先每次 tick 都会跑「一整天 / 一周 / 一个月才需要
 * 一次」的清理与日报统计，720 次/天白做，其中日报那几条还是全表扫描
 * （见 `collectDailySummary`）。这里只保留真正需要及时性的：**超时牌局退款**
 * （牌局 30 分钟有效，本金不能等到第二天才退）与**入群验证超时处理**
 * （超时 5~30 分钟，同样不能等到日报）。
 */
export async function cleanupTimely(env, token = null) {
  const empty = {
    blackjackSessions: 0, blackjackRefunded: 0, blackjackFailed: 0,
    joinVerifications: { checked: 0, kicked: 0, released: 0, failed: 0 },
    draws: { checked: 0, drawn: 0 }
  };
  if (!env?.DB) return empty;

  const blackjack = await refundStaleBlackjack(env);

  // 群内抽奖到点开奖（v3.10.0）：报名时长最短 10 分钟，
  // 和牌局、入群验证一样属于「等不到第二天的及时型」，所以挂在每 2 分钟的 tick 上。
  let draws = empty.draws;
  if (token) {
    try {
      draws = await processDueDraws(env, token);
    } catch (e) {
      logError("抽奖自动开奖失败：", e);
    }
  }

  // 入群验证超时：没点「通过验证」的新成员，按本群配置踢出或仅解除限制
  let joinVerifications = empty.joinVerifications;
  if (token) {
    try {
      joinVerifications = await processJoinVerifications(env, token);
    } catch (e) {
      logError("入群验证超时处理失败：", e);
    }
  }

  return { ...blackjack, joinVerifications, draws };
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
  /** 处理完的待删记录（成功失败都算，失败重试没有意义） */
  const doneIds = [];
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
    doneIds.push(Number(row.id));
  }

  // 一次 IN 收口：原先每行一条 DELETE，30 条/次 × 720 次/天 ≈ 2 万条多余语句
  if (doneIds.length > 0) {
    const placeholders = doneIds.map(() => "?").join(", ");
    await env.DB.prepare(
      `DELETE FROM pending_deletes WHERE id IN (${placeholders})`
    ).bind(...doneIds).run();
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
  const isDailyRun = !cron || cron === DAILY_SUMMARY_CRON;
  countUsage(env, METRIC.CRON);

  // ---------- 每次 tick 都要做的（及时型）----------
  // 1) 长延时自动删除：到点就该删，不能等日报
  let pendingDeletes = null;
  if (token && env?.DB) {
    try {
      pendingDeletes = await processPendingDeletes(env, token);
    } catch (e) {
      logError("处理待删除消息失败：", e);
    }
  }

  // 2) 超时牌局退款 + 入群验证超时处理
  const timely = await cleanupTimely(env, token);

  // 3) webhook 自愈巡检（isolate 内每 10 分钟最多查一次）
  let webhook = null;
  if (token && env?.DB) {
    try {
      webhook = await ensureWebhook(env, token);
    } catch (e) {
      logError("webhook 巡检失败：", e);
    }
  }

  // ---------- 日级维护：只在「每天一次」的那条 cron 跑 ----------
  // 以前这些是每次 tick 都跑：15 条「一整天/一周/一个月才需要一次」的清理 +
  // 7 条只为日报服务的统计（还都是全表扫描），720 次/天纯属白做。v3.7.0 拆开。
  if (!isDailyRun) {
    logInfo("跳过日级维护（非日报时段）：", JSON.stringify({ cron, timely, pendingDeletes, webhook }));
    return { timely, pendingDeletes, webhook, notified: false, skipped: "非日报时段" };
  }

  const cleanup = await cleanupStaleData(env);
  const summary = await collectDailySummary(env);

  // ---------- 📰 每日群报（v3.10.0）----------
  // 只给「开启了群报且昨天有消息」的群生成，一次最多几个群（模型调用要控量）。
  // 放在「每日概况」推送**之前**：概况有自己的去重标记，命中时会提前 return。
  const adminChatForReports = resolveAdminChatId(env);
  let groupReports = { chats: 0, sent: 0 };
  if (token && adminChatForReports) {
    try {
      groupReports = await pushDailyReports({
        env, token, ctx, adminChatId: adminChatForReports
      });
    } catch (e) {
      logError("推送每日群报失败：", e);
    }
  }

  // 索引维护：补上「上传时没有 AI」或「换过向量模型」的分块（每次有上限，分多次跑完）。
  // 刻意留在每次 tick：换模型后要靠它分批补，放到日报会让 400 块要补 20 天。
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
    groupReports,
    summary: { ...summary, pendingList: summary.pendingList.length }
  }));

  // 到期通知：限时禁言/封禁由 Telegram 自动解除，这里补一条公告 + 私聊当事人
  if (token && expiredList.length > 0) {
    await notifyExpiredPunishments(token, expiredList, env, ctx);
  }

  const adminChat = resolveAdminChatId(env);
  if (!token || !adminChat) return { cleanup: cleanupCounts, summary, reindex, notified: false };

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
