// ==========================================
// 📇 用户详情（聚合页）
//
// 以前看一个用户要在「积分 / 流水 / 限额 / 频率」四个面板之间来回切，
// 这里把关键信息聚合到一屏：身份、积分、签到、今日任务、最近流水、
// 最近订单、最近群内处置。
//
// 入口：用户管理 → 私聊/群组用户 → 场景编辑 → 📇 用户详情
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { LAYOUT } from "../utils/layout.js";
import { getDateKey } from "../services/time.js";
import { computeCheckinStreak } from "../services/checkin.js";
import { getTodayTasks } from "../services/tasks.js";
import { listRecentPunishmentsByUser, ACTIONS } from "../services/guard.js";

/** 处置状态 → 文案 */
const STATUS_TEXT = {
  pending: "⏳ 待确认",
  done: "✅ 已执行",
  cancelled: "🚫 已取消",
  rejected: "❌ 理由不成立",
  failed: "⚠️ 失败",
  expired: "⌛ 已到期",
  revoked: "↩️ 已撤销"
};

/** 渲染用户详情聚合页 */
export async function renderUserDetail(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;

  const scene = await env.DB.prepare(
    `SELECT s.id, s.scene_key, s.user_key, s.user_id, s.chat_id, s.chat_type,
            s.username, s.first_name, s.lang, s.max_daily, s.rate_limit_sec, s.updated_at,
            COALESCE(u.points, 0) AS points,
            COALESCE(u.blocked, 0) AS blocked
     FROM user_scenes s LEFT JOIN users u ON u.user_key = s.user_key
     WHERE s.id = ?`
  ).bind(rowId).first();

  if (!scene) {
    return editMessageText(token, chatId, messageId, `❌ 场景 #${rowId} 未找到。`,
      { inline_keyboard: [[{ text: "🔙 返回用户列表", callback_data: "admin_users_private_1" }]] });
  }

  const today = getDateKey(env);
  const [checkins, dailyRow, tasks, logs, orders, punishments, todayCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM daily_checkin WHERE user_key = ?").bind(scene.user_key).first(),
    env.DB.prepare("SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?").bind(scene.scene_key, today).first(),
    getTodayTasks(env, scene.user_key),
    env.DB.prepare(
      "SELECT change_amount, balance_after, reason, created_at FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT 3"
    ).bind(scene.user_key).all(),
    env.DB.prepare(
      "SELECT order_no, item_name, price, status, created_at FROM shop_orders WHERE user_key = ? ORDER BY id DESC LIMIT 3"
    ).bind(scene.user_key).all(),
    listRecentPunishmentsByUser(env, scene.user_id, 3),
    scene.chat_type === "private" || !scene.chat_type
      ? Promise.resolve({ n: 0 })
      : env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_stats WHERE scene_key = ?").bind(scene.scene_key).first()
  ]);

  const totalCheckins = Number(checkins?.n) || 0;
  const streak = await computeCheckinStreak(env, scene.user_key, today);
  const spent = (logs.results || []).reduce((sum, l) => sum + Math.min(0, Number(l.change_amount) || 0), 0);
  const statusMap = { pending: "⏳", done: "✅", cancelled: "❌" };

  let text = `📇 <b>用户详情</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `👤 <b>${escapeHtml(scene.first_name || "未命名")}</b>`;
  text += scene.username ? `（@${escapeHtml(scene.username)}）` : ``;
  text += `\n🆔 <code>${escapeHtml(scene.user_id || "")}</code>`;
  text += ` · 🧩 <code>#${scene.id}</code>\n`;
  text += `🏠 ${scene.chat_type === "private" ? "💬 私聊" : `👥 群 <code>${escapeHtml(scene.chat_id)}</code>`}\n`;
  text += `🔘 <b>状态：</b>${Number(scene.blocked) === 1 ? "🚫 已封禁" : "✅ 正常"} · 🪙 <b>${Number(scene.points) || 0}</b>\n\n`;

  text += `📅 <b>签到：</b>累计 ${totalCheckins} 天 · 连续 ${streak} 天\n`;
  text += `✅ <b>今日任务：</b>${tasks.done}/${tasks.total}${tasks.allDone ? "（已全勤 🎉）" : ""}\n`;
  text += `📊 <b>本场景今日消息：</b>${Number(dailyRow?.count) || 0} 条`;
  if (Number(todayCount?.n) > 0) text += ` · 累计 ${Number(todayCount.n)} 条`;
  text += `\n🌐 <b>语言：</b>${escapeHtml(scene.lang || "zh")} · ⏱️ <b>冷却：</b>${Number(scene.rate_limit_sec) || 0} 秒\n`;

  text += `\n📜 <b>最近积分变动：</b>\n`;
  if ((logs.results || []).length === 0) text += `<i>暂无记录</i>\n`;
  else {
    for (const log of logs.results) {
      const amount = Number(log.change_amount) || 0;
      text += `${amount >= 0 ? "🟢 +" : "🔴 "}${amount} · 余额 ${Number(log.balance_after) || 0} · ${escapeHtml(log.reason || "")}\n`;
    }
  }

  text += `\n🧾 <b>最近订单：</b>\n`;
  if ((orders.results || []).length === 0) text += `<i>暂无订单</i>\n`;
  else {
    for (const order of orders.results) {
      text += `${statusMap[order.status] || "❔"} <code>${escapeHtml(order.order_no)}</code> ${escapeHtml(order.item_name)} · 🪙 ${order.price}\n`;
    }
  }

  text += `\n🛡️ <b>最近处置：</b>\n`;
  if (punishments.length === 0) text += `<i>没有处置记录</i>\n`;
  else {
    for (const row of punishments) {
      text += `${STATUS_TEXT[row.status] || row.status} · ${ACTIONS[row.action]?.short || row.action} · ${escapeHtml(row.reason || "")}\n`;
    }
  }
  if (spent < 0) text += `\n💰 最近消耗：${spent}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🪙 积分管理", callback_data: `admin_menu_pts_${scene.id}` },
        { text: "📜 积分流水", callback_data: `admin_log_pts_${scene.id}_1` }
      ],
      [
        { text: "📅 限额", callback_data: `admin_menu_limit_${scene.id}` },
        { text: "⏱️ 频率", callback_data: `admin_menu_rate_${scene.id}` }
      ],
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${scene.id}` }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}
