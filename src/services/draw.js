// ==========================================
// 🎁 群内抽奖（v3.10.0）
//
// 流程：管理员在群里发起 → 成员点按钮报名 → 到点（或管理员手动）开奖。
//
// 三条与「钱」有关的约定（照抄 21 点与商城的教训）：
//   1. **开奖只认一条原子语句**：`UPDATE ... WHERE status='open'` 的
//      `meta.changes === 1` 才是唯一凭据 —— 到点 cron 与管理员手动开奖可能并发，
//      拿 SELECT 的结果当凭据就会发两次奖（v3.6.1 的 21 点事故）。
//   2. **报名用 INSERT ... ON CONFLICT DO NOTHING**：同一个人反复点只算一次，
//      连点也不会刷出多份份额。
//   3. **中奖积分复用 refundPoint**（= 原子加分 + 写 points_log）：
//      不自己写 UPDATE users，避免出现「加了分但没有流水」的对账黑洞。
// ==========================================

import { DRAW } from "../config/constants.js";
import { logError, logInfo } from "../core/logger.js";
import {
  editMessageText, sendMessage, sendMessageWithKeyboard
} from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid } from "../utils/layout.js";
import { randomInt } from "../utils/random.js";
import { refundPoint } from "./points.js";
import { getDateKey, formatAppTime } from "./time.js";
import { countUsage, METRIC } from "./usage.js";

const PREFIX = "draw";

/** 回调数据（简单两段式：draw_<动作>_<id>） */
export const DRAW_CALLBACK = {
  JOIN_PREFIX: `${PREFIX}_join_`,
  END_PREFIX: `${PREFIX}_end_`,
  CANCEL_PREFIX: `${PREFIX}_cancel_`
};

// ==========================================
// 🎲 抽奖的纯逻辑（可测）
// ==========================================

/**
 * 解析 `/draw 100 3 60 周末活动` 这类参数。
 * 规则：第 1 个参数是奖品积分，后面**连续的数字**依次是人数与时长，
 * 第一个非数字开始就是标题 —— 这样「/draw 50 周末活动」也能用。
 * @returns {{ok:true, prize:number, winners:number, minutes:number, title:string}|{ok:false, error:string}}
 */
export function parseDrawArgs(rawText) {
  const parts = String(rawText || "").trim().split(/\s+/).slice(1);
  if (parts.length === 0 || !parts[0]) {
    return { ok: false, error: "请给出奖品积分，例如 <code>/draw 50 周末抽奖</code>" };
  }

  const prize = Number.parseInt(parts[0], 10);
  if (!Number.isInteger(prize) || prize <= 0) {
    return { ok: false, error: "奖品积分必须是正整数，例如 <code>/draw 50</code>" };
  }
  if (prize > DRAW.MAX_PRIZE) {
    return { ok: false, error: `单个中奖者的积分不能超过 ${DRAW.MAX_PRIZE}` };
  }

  let idx = 1;
  let winners = 1;
  let minutes = DRAW.DURATION_CHOICES[1] || 60;

  if (/^\d+$/.test(parts[idx] || "")) {
    winners = Number.parseInt(parts[idx], 10);
    idx++;
  }
  if (/^\d+$/.test(parts[idx] || "")) {
    minutes = Number.parseInt(parts[idx], 10);
    idx++;
  }

  if (!Number.isInteger(winners) || winners <= 0) winners = 1;
  if (winners > DRAW.MAX_WINNERS) {
    return { ok: false, error: `中奖人数不能超过 ${DRAW.MAX_WINNERS}` };
  }
  if (!Number.isInteger(minutes) || minutes <= 0) minutes = 60;
  if (minutes > 24 * 60) return { ok: false, error: "报名时长不能超过 24 小时" };

  const title = parts.slice(idx).join(" ").trim().slice(0, DRAW.TITLE_MAX) || "积分抽奖";
  return { ok: true, prize, winners, minutes, title };
}

/**
 * 从报名名单里**无放回**地抽 count 个中奖者。
 * 用 crypto 随机源（random.js），抽不满就返回全部（人少不算异常）。
 */
export function pickWinners(entries, count) {
  const pool = Array.isArray(entries) ? [...entries] : [];
  const want = Math.max(0, Math.min(Math.floor(Number(count) || 0), pool.length));
  const picked = [];
  for (let i = 0; i < want; i++) {
    const idx = randomInt(pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

// ==========================================
// 🎨 卡片渲染
// ==========================================

/** 抽奖卡片正文（纯函数，便于测试） */
export function drawCardText(env, draw, entryCount) {
  const lines = [];
  lines.push(`🎁 <b>${escapeHtml(String(draw.title || "积分抽奖"))}</b>`);
  lines.push("-------------------------");
  lines.push(`🪙 每人 <b>${draw.prize}</b> 积分　·　🏆 抽 <b>${draw.winners}</b> 人`);
  if (draw.status === "open") {
    lines.push(`👥 已报名：<b>${entryCount}</b> 人`);
    if (Number(draw.end_at) > 0) {
      const left = Number(draw.end_at) - Math.floor(Date.now() / 1000);
      lines.push(`⏱ ${left > 0 ? `${formatLeft(left)}后自动开奖` : "即将开奖"}`);
    } else {
      lines.push(`⏱ 由管理员手动开奖`);
    }
    lines.push("");
    lines.push("点下面的按钮即可参加，<b>每人一次</b>。");
  } else if (draw.status === "drawn") {
    lines.push("");
    lines.push(`🎉 <b>已开奖</b>（共 ${entryCount} 人参加）`);
  } else {
    lines.push("");
    lines.push("🚫 本次抽奖已取消。");
  }
  return lines.join("\n");
}

/** 倒计时文案（秒 → 「x 分钟 / x 小时」） */
export function formatLeft(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

/** 卡片键盘（报名按钮显示已报名人数） */
export function drawKeyboard(draw, entryCount) {
  if (draw.status !== "open") return { inline_keyboard: [] };
  return {
    inline_keyboard: grid([
      { text: `🎉 参与（${entryCount} 人）`, callback_data: `${DRAW_CALLBACK.JOIN_PREFIX}${draw.id}` }
    ])
  };
}

/** 刷新卡片（消息可能已被删除，失败不影响开奖结果） */
async function refreshCard(env, token, draw, entryCount) {
  if (!draw?.msg_id) return;
  try {
    await editMessageText(
      token, draw.chat_id, draw.msg_id,
      drawCardText(env, draw, entryCount),
      drawKeyboard(draw, entryCount),
      "HTML"
    );
  } catch (e) {
    // 「消息没改动」之类的 Telegram 报错很常见，不值得刷日志
  }
}

// ==========================================
// 📥 创建 / 报名 / 开奖
// ==========================================

/** 读一个抽奖 */
export async function getDraw(env, drawId) {
  if (!env?.DB) return null;
  return env.DB.prepare("SELECT * FROM group_draws WHERE id = ?")
    .bind(Number(drawId)).first();
}

/** 报名人数 */
export async function countEntries(env, drawId) {
  if (!env?.DB) return 0;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM group_draw_entries WHERE draw_id = ?"
  ).bind(Number(drawId)).first();
  return Number(row?.n) || 0;
}

/** 报名名单 */
export async function listEntries(env, drawId) {
  if (!env?.DB) return [];
  const { results } = await env.DB.prepare(
    "SELECT user_key, user_id, user_name FROM group_draw_entries WHERE draw_id = ? ORDER BY joined_at ASC LIMIT ?"
  ).bind(Number(drawId), DRAW.MAX_ENTRIES_PER_DRAW).all();
  return results || [];
}

/**
 * 创建抽奖并发卡片。
 * @returns {Promise<{ok:boolean, error?:string, id?:number}>}
 */
export async function createDraw({ env, token, chatId, operatorId, rawText, ctx = null }) {
  if (!env?.DB) return { ok: false, error: "❌ 未绑定数据库。" };

  const parsed = parseDrawArgs(rawText);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // 同一个群只允许一个进行中的抽奖：否则「点按钮参与」会分不清参与的是哪一场
  const openRow = await env.DB.prepare(
    "SELECT id FROM group_draws WHERE chat_id = ? AND status = 'open' LIMIT 1"
  ).bind(String(chatId)).first();
  if (openRow) {
    return {
      ok: false,
      error: `⚠️ 本群已有一个进行中的抽奖（#${openRow.id}）。\n先用 <code>/draw_end</code> 开奖，或 <code>/draw_cancel</code> 取消。`
    };
  }

  const endAt = Math.floor(Date.now() / 1000) + parsed.minutes * 60;
  const res = await env.DB.prepare(`
    INSERT INTO group_draws (chat_id, title, prize, winners, status, end_at, operator_id)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
  `).bind(
    String(chatId), parsed.title, parsed.prize, parsed.winners, endAt, String(operatorId || "")
  ).run();

  const drawId = Number(res.meta?.last_row_id) || 0;
  if (!drawId) return { ok: false, error: "❌ 创建失败，请稍后重试。" };

  const draw = await getDraw(env, drawId);
  const messageId = await sendMessageWithKeyboard(
    token, chatId,
    drawCardText(env, draw, 0),
    drawKeyboard(draw, 0),
    "HTML"
  );

  // 记下卡片消息 ID，之后每次有人报名就原地刷新
  const cardId = extractMessageId(messageId);
  if (cardId) {
    await env.DB.prepare("UPDATE group_draws SET msg_id = ? WHERE id = ?")
      .bind(cardId, drawId).run();
  }

  countUsage(env, METRIC.SUMMARY);   // 复用「群内活动」量级，不单独开指标
  logInfo(`群里发起抽奖 #${drawId}（${parsed.title}）：${parsed.prize} 分 × ${parsed.winners}`);
  return { ok: true, id: drawId };
}

/** 从 sendMessage 的返回体里取消息 ID（兼容两种返回结构） */
function extractMessageId(res) {
  const id = res?.result?.message_id ?? res?.message_id;
  return Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : 0;
}

/**
 * 成员点「🎉 参与」。
 * 幂等：同一个人重复点只留一条（主键冲突直接忽略）。
 */
export async function joinDraw({ env, token, chatId, userKey, userId, userName, drawId }) {
  if (!env?.DB) return { ok: false, error: "❌ 未绑定数据库。" };

  const draw = await getDraw(env, drawId);
  if (!draw) return { ok: false, error: "❌ 抽奖不存在。" };
  if (String(draw.chat_id) !== String(chatId)) {
    return { ok: false, error: "⚠️ 这不是本群的抽奖。" };
  }
  if (draw.status !== "open") return { ok: false, error: "⚠️ 本次抽奖已经结束了。" };
  if (Number(draw.end_at) > 0 && Number(draw.end_at) < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "⏱ 报名时间已过，正在开奖…" };
  }

  // 报名的前提是有账户（发奖要加到 users.points）。
  // 没和机器人说过话的人先补一条，避免「中了奖却发不出去」。
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (user_key, user_id, first_name, points) VALUES (?, ?, ?, 100)"
  ).bind(String(userKey), String(userId || ""), String(userName || "").slice(0, 60)).run();

  const ins = await env.DB.prepare(`
    INSERT INTO group_draw_entries (draw_id, user_key, user_id, user_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(draw_id, user_key) DO NOTHING
  `).bind(Number(drawId), String(userKey), String(userId || ""), String(userName || "").slice(0, 40)).run();

  const joined = Number(ins.meta?.changes) === 1;
  const total = await countEntries(env, drawId);

  // 只有真的新增了才刷新卡片，避免连点刷出一串无意义的 edit 请求
  if (joined) await refreshCard(env, token, draw, total);

  return { ok: true, joined, total, duplicate: !joined };
}

/**
 * 开奖。**唯一凭据是 `status: open → drawn` 的原子更新**，
 * 所以「到点 cron」与「管理员手动开奖」同时发生也只会发一次奖。
 */
export async function drawWinners({ env, token, drawId, announce = true, actorId = "" }) {
  if (!env?.DB) return { ok: false, error: "❌ 未绑定数据库。" };

  const occupied = await env.DB.prepare(
    "UPDATE group_draws SET status = 'drawn', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'"
  ).bind(Number(drawId)).run();

  if (Number(occupied.meta?.changes) !== 1) {
    return { ok: false, error: "⚠️ 这次抽奖已经开过奖了。" };
  }

  const draw = await getDraw(env, drawId);
  const entries = await listEntries(env, drawId);
  const winners = pickWinners(entries, draw.winners);

  // 发奖：每一个都用 refundPoint（原子加分 + 流水）。失败不影响其他人。
  const paid = [];
  for (const winner of winners) {
    const balance = await refundPoint(
      env, winner.user_key, Number(draw.prize) || 0, `群内抽奖中奖（#${draw.id} ${draw.title}）`
    );
    if (balance !== null) paid.push(winner);
    else logError(`抽奖发奖失败（#${draw.id} / ${winner.user_key}）`);
  }

  await env.DB.prepare(
    "UPDATE group_draws SET winner_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(paid.map((w) => w.user_key).join(",").slice(0, 2000), Number(drawId)).run();

  await refreshCard(env, token, draw, entries.length);

  if (announce) {
    await announceResult(env, token, draw, paid, entries.length, actorId);
  }

  logInfo(`抽奖开奖 #${draw.id}：${entries.length} 人参加，${paid.length} 人中奖`);
  return { ok: true, winners: paid, entries: entries.length };
}

/** 群里公布结果（没人的时候也明说，别让人以为是机器人卡住了） */
async function announceResult(env, token, draw, winners, entryCount, actorId = "") {
  const lines = [];
  lines.push(`🎉 <b>开奖啦</b> · ${escapeHtml(String(draw.title || ""))}`);
  lines.push("-------------------------");

  if (winners.length === 0) {
    lines.push(entryCount === 0 ? "😅 没有人报名，本次抽奖作废。" : "😅 没有抽到中奖者。");
  } else {
    lines.push(`🏆 中奖（每人 <b>${draw.prize}</b> 积分）：`);
    for (const w of winners) {
      const label = w.user_name ? escapeHtml(String(w.user_name)) : `<code>${escapeHtml(String(w.user_id || w.user_key))}</code>`;
      lines.push(`· ${label}`);
    }
    lines.push("");
    lines.push(`积分已直接入账，可用 /points 查看流水。`);
  }

  try {
    await sendMessage(token, draw.chat_id, lines.join("\n"), "HTML");
  } catch (e) {
    logError("公布开奖结果失败：", e);
  }
}

/** 取消抽奖（只能取消还没开奖的） */
export async function cancelDraw({ env, token, drawId }) {
  if (!env?.DB) return { ok: false, error: "❌ 未绑定数据库。" };

  const res = await env.DB.prepare(
    "UPDATE group_draws SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'"
  ).bind(Number(drawId)).run();
  if (Number(res.meta?.changes) !== 1) {
    return { ok: false, error: "⚠️ 这次抽奖已经结束，无法取消。" };
  }

  const draw = await getDraw(env, drawId);
  const total = await countEntries(env, drawId);
  await refreshCard(env, token, draw, total);
  return { ok: true };
}

/**
 * 到点的抽奖自动开奖（每 2 分钟的 cron）。
 * 一次最多处理几个，避免一个 tick 里发太多奖。
 */
export async function processDueDraws(env, token, { limit = 5 } = {}) {
  if (!env?.DB || !token) return { checked: 0, drawn: 0 };
  const nowSec = Math.floor(Date.now() / 1000);

  let due = [];
  try {
    const { results } = await env.DB.prepare(`
      SELECT id FROM group_draws
      WHERE status = 'open' AND end_at > 0 AND end_at <= ?
      ORDER BY end_at ASC LIMIT ?
    `).bind(nowSec, Math.max(1, Number(limit) || 5)).all();
    due = results || [];
  } catch (e) {
    logError("查询到点抽奖失败：", e);
    return { checked: 0, drawn: 0 };
  }

  let drawn = 0;
  for (const row of due) {
    const res = await drawWinners({ env, token, drawId: row.id });
    if (res.ok) drawn++;
  }
  return { checked: due.length, drawn };
}

// ==========================================
// ⌨️ 命令入口
// ==========================================

export async function cmdDraw({ env, token, chatId, isGroupCtx, uctx, rawText, ctx = null }) {
  if (!isGroupCtx) {
    return sendMessage(token, chatId,
      "🎁 <b>群内抽奖</b>\n-------------------------\n请在<b>群里</b>发起抽奖。", "HTML");
  }
  const res = await createDraw({
    env, token, chatId, operatorId: uctx?.userId, rawText, ctx
  });
  if (!res.ok) return sendMessage(token, chatId, res.error, "HTML");
}

export async function cmdDrawEnd({ env, token, chatId, isGroupCtx, uctx }) {
  if (!isGroupCtx) return sendMessage(token, chatId, "请在群里使用。");
  if (!env?.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const open = await env.DB.prepare(
    "SELECT id FROM group_draws WHERE chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
  ).bind(String(chatId)).first();
  if (!open) return sendMessage(token, chatId, "ℹ️ 本群没有进行中的抽奖。");

  const res = await drawWinners({ env, token, drawId: open.id, actorId: uctx?.userId });
  if (!res.ok) return sendMessage(token, chatId, res.error, "HTML");
}

export async function cmdDrawCancel({ env, token, chatId, isGroupCtx }) {
  if (!isGroupCtx) return sendMessage(token, chatId, "请在群里使用。");
  if (!env?.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const open = await env.DB.prepare(
    "SELECT id FROM group_draws WHERE chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
  ).bind(String(chatId)).first();
  if (!open) return sendMessage(token, chatId, "ℹ️ 本群没有进行中的抽奖。");

  const res = await cancelDraw({ env, token, drawId: open.id });
  if (!res.ok) return sendMessage(token, chatId, res.error, "HTML");
  return sendMessage(token, chatId, "🚫 已取消本次抽奖。");
}
