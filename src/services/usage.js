// ==========================================
// 📊 用量与成本统计（v3.10.0）
//
// 「只有错误告警、没有趋势」是原来的短板：模型调用失败率、每天用了多少次 AI、
// D1 写了多少行，全靠 /tail 现场看。
//
// 做法：内存里按「日期 + 指标」累加，请求结束时合并成**一次 batch UPSERT**
// （见 handlers/message.js 与 index.js 的 ctx.waitUntil(flushUsage)）。
// 一天的同一个指标只占一行，写入量与消息量无关，只与「指标种类」有关。
//
// ⚠️ 计数是**近似值**：多个 isolate 各算各的，等待 reclaim 时未 flush 的部分会丢。
// 用来观察趋势足够，不要拿它做计费依据。
// ==========================================

import { USAGE } from "../config/constants.js";
import { logError } from "../core/logger.js";
import { getDateKey, shiftDateKey } from "./time.js";

/** "日期|指标" → 次数 */
const buffer = new Map();
/** 上次落库时间（毫秒） */
let lastFlushAt = 0;

/** 测试用：清空缓冲 */
export function resetUsageBuffer() {
  buffer.clear();
  lastFlushAt = 0;
}

/** 当前缓冲里的条目数（测试用） */
export function pendingUsageCount() {
  let total = 0;
  for (const n of buffer.values()) total += n;
  return total;
}

// ---------- 指标名 ----------
/** 指标用「域.动作」命名，面板按前缀聚合 */
export const METRIC = {
  AI_CALL: "ai.call",
  AI_FAIL: "ai.fail",
  AI_FALLBACK: "ai.fallback",
  MSG_IN: "msg.in",
  MSG_OUT: "msg.out",
  KB_EMBED: "kb.embed",
  KB_SEARCH: "kb.search",
  CRON: "cron.run",
  AUTOMOD: "automod.hit",
  SUMMARY: "summary.gen",
  MEMORY: "memory.gen"
};

/** 模型调用次数按模型名分开记（`ai.model.<模型>`），便于看回退到哪个模型 */
export function modelMetric(model) {
  const name = String(model || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  return `ai.model.${name}`;
}

/**
 * 记一次用量（只写内存，不碰 D1）。
 * 内存满时**直接丢弃**：统计不能因为爆内存把主流程拖垮。
 */
export function countUsage(env, metric, n = 1) {
  if (!env?.DB || !metric) return false;
  const amount = Number(n) || 0;
  if (amount <= 0) return false;

  const key = `${getDateKey(env)}|${metric}`;
  if (!buffer.has(key) && buffer.size >= USAGE.MAX_BUFFER_KEYS) return false;
  buffer.set(key, (buffer.get(key) || 0) + amount);
  return true;
}

/**
 * 把缓冲合并成一次 batch 落库。
 * 默认会做「攒够阈值 / 间隔够了才写」的节流；传 force = true 立即写。
 * @returns {Promise<number>} 落库的指标条数
 */
export async function flushUsage(env, { force = false } = {}) {
  if (!env?.DB || buffer.size === 0) return 0;

  const now = Date.now();
  if (!force && now - lastFlushAt < USAGE.FLUSH_INTERVAL_MS) return 0;

  // 一次只写这么多条，剩下的留给下一次（避免单次 D1 调用过大）
  const entries = [...buffer.entries()].slice(0, USAGE.MAX_FLUSH_STATEMENTS);
  for (const [key] of entries) buffer.delete(key);
  lastFlushAt = now;

  const stmts = entries.map(([key, count]) => {
    const sep = key.indexOf("|");
    const dateStr = key.slice(0, sep);
    const metric = key.slice(sep + 1);
    return env.DB.prepare(`
      INSERT INTO usage_stats (date_str, metric, count, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(date_str, metric) DO UPDATE SET
        count = count + EXCLUDED.count,
        updated_at = CURRENT_TIMESTAMP
    `).bind(dateStr, metric, count);
  });

  try {
    await env.DB.batch(stmts);
    return stmts.length;
  } catch (e) {
    logError("用量统计落库失败：", e);
    return 0;
  }
}

/** 一次查询里读最近 N 天的所有指标 */
export async function readUsage(env, days = USAGE.PANEL_DAYS) {
  if (!env?.DB) return [];
  const span = Math.max(1, Math.min(30, Number(days) || USAGE.PANEL_DAYS));
  const from = shiftDateKey(getDateKey(env), -(span - 1));
  try {
    const { results } = await env.DB.prepare(
      "SELECT date_str, metric, count FROM usage_stats WHERE date_str >= ? ORDER BY date_str DESC, metric ASC"
    ).bind(from).all();
    return results || [];
  } catch (e) {
    logError("读取用量统计失败：", e);
    return [];
  }
}

/**
 * 把明细行聚合成「日期 → 指标 → 次数」。
 * 同一前缀的模型指标额外汇总成 `ai.model.*` 的分项，面板上按模型拆分展示。
 */
export function groupUsage(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    const date = String(row.date_str || "");
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const day = byDate.get(date);
    const metric = String(row.metric || "");
    day.set(metric, (day.get(metric) || 0) + (Number(row.count) || 0));
  }
  return byDate;
}

/** 某个指标在最近 N 天的合计（供面板写「7 天累计」） */
export function sumMetric(byDate, metric) {
  let total = 0;
  for (const day of byDate.values()) total += day.get(metric) || 0;
  return total;
}

/** 定时清理：明细只留 KEEP_DAYS 天 */
export async function cleanupUsage(env) {
  if (!env?.DB) return 0;
  try {
    const cutoff = shiftDateKey(getDateKey(env), -USAGE.KEEP_DAYS);
    const res = await env.DB.prepare("DELETE FROM usage_stats WHERE date_str < ?").bind(cutoff).run();
    return Number(res.meta?.changes) || 0;
  } catch (e) {
    logError("清理用量统计失败：", e);
    return 0;
  }
}
