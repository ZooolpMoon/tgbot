// ==========================================
// 📊 用量与成本面板（v3.10.0）
//
// 入口：/usage（需要「查看统计」权限）
//
// 回答的问题是「这几天机器人到底跑了多少、模型稳不稳」：
//   • AI 调用次数与失败率（失败率突然上升 = 模型或配额出了问题）
//   • 回退到备用模型的次数（主模型不稳的信号）
//   • 各模型的实际调用分布（换模型前后可以对比）
//   • 群消息量与知识库检索量（判断负载在哪）
//
// ⚠️ 数字是**近似值**：多 isolate 各算各的，未落库的部分会随 isolate 回收丢失
// （见 services/usage.js 的说明）。看趋势够用，别拿去对账。
// ==========================================

import { sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK, USAGE } from "../config/constants.js";
import { readUsage, groupUsage, METRIC } from "../services/usage.js";
import { getDateKey } from "../services/time.js";

/** 百分比文案（分母为 0 时给「—」而不是 NaN） */
export function rateText(part, total) {
  const t = Number(total) || 0;
  if (t <= 0) return "—";
  return `${((Number(part) || 0) / t * 100).toFixed(1)}%`;
}

/**
 * 把明细聚合成面板要展示的结构（纯函数，便于测试）。
 * @param {Map<string, Map<string, number>>} byDate
 */
export function summarizeUsage(byDate) {
  const acc = {
    aiCall: 0, aiFail: 0, aiFallback: 0, msgIn: 0, kbSearch: 0, kbEmbed: 0,
    summary: 0, memory: 0, automod: 0, cron: 0,
    models: new Map(),
    days: []
  };

  for (const [date, day] of byDate.entries()) {
    const get = (key) => day.get(key) || 0;
    acc.aiCall += get(METRIC.AI_CALL);
    acc.aiFail += get(METRIC.AI_FAIL);
    acc.aiFallback += get(METRIC.AI_FALLBACK);
    acc.msgIn += get(METRIC.MSG_IN);
    acc.kbSearch += get(METRIC.KB_SEARCH);
    acc.kbEmbed += get(METRIC.KB_EMBED);
    acc.summary += get(METRIC.SUMMARY);
    acc.memory += get(METRIC.MEMORY);
    acc.automod += get(METRIC.AUTOMOD);
    acc.cron += get(METRIC.CRON);

    for (const [metric, count] of day.entries()) {
      if (!metric.startsWith("ai.model.")) continue;
      const name = metric.slice("ai.model.".length);
      acc.models.set(name, (acc.models.get(name) || 0) + count);
    }

    acc.days.push({ date, ai: get(METRIC.AI_CALL), msg: get(METRIC.MSG_IN) });
  }

  acc.days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return acc;
}

/** 面板正文 */
export function usagePanelText(data) {
  const lines = [];
  lines.push(`📊 <b>用量与成本</b>（最近 ${USAGE.PANEL_DAYS} 天）`);
  lines.push(LAYOUT.DIVIDER);

  lines.push(`🤖 AI 调用：<b>${data.aiCall}</b> 次　·　失败 <b>${data.aiFail}</b>（${rateText(data.aiFail, data.aiCall + data.aiFail)}）`);
  if (data.aiFallback > 0) {
    lines.push(`↩️ 回退到备用模型：<b>${data.aiFallback}</b> 次`);
  }
  lines.push(`💬 群消息：<b>${data.msgIn}</b> 条`);
  if (data.kbSearch > 0 || data.kbEmbed > 0) {
    lines.push(`📚 知识库：检索 <b>${data.kbSearch}</b> 次　·　入库向量 <b>${data.kbEmbed}</b> 块`);
  }
  const extras = [];
  if (data.summary > 0) extras.push(`📰 群报 ${data.summary}`);
  if (data.memory > 0) extras.push(`🧠 记忆压缩 ${data.memory}`);
  if (data.automod > 0) extras.push(`🧹 自动处置 ${data.automod}`);
  if (extras.length > 0) lines.push(extras.join("　·　"));

  if (data.models.size > 0) {
    lines.push("");
    lines.push("🧩 <b>各模型调用</b>");
    const sorted = [...data.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [name, n] of sorted) {
      // 模型名很长，短名展示即可（去掉厂商前缀）
      const short = String(name).replace(/^@cf\//, "").slice(0, 34);
      lines.push(`· <code>${escapeHtml(short)}</code>　${n}`);
    }
  }

  if (data.days.length > 0) {
    lines.push("");
    lines.push("📅 <b>按天</b>（AI / 消息）");
    for (const day of data.days.slice(0, USAGE.PANEL_DAYS)) {
      lines.push(`· ${escapeHtml(day.date)}　${day.ai} / ${day.msg}`);
    }
  } else {
    lines.push("");
    lines.push("<i>还没有统计数据。发几条消息或让 AI 回答一次，这里就会有数字。</i>");
  }

  lines.push("");
  lines.push("<i>统计为近似值（多实例各算各的），用于看趋势。</i>");
  return lines.join("\n");
}

/** 渲染用量面板 */
export async function renderUsagePanel(token, env, chatId, messageId = null) {
  if (!env?.DB) {
    const text = "❌ 未绑定数据库，无法统计。";
    return messageId
      ? editMessageText(token, chatId, messageId, text)
      : sendMessageWithKeyboard(token, chatId, text, { inline_keyboard: [] });
  }

  const rows = await readUsage(env, USAGE.PANEL_DAYS);
  const data = summarizeUsage(groupUsage(rows));
  const text = usagePanelText(data);
  const keyboard = {
    inline_keyboard: [[{ text: "🔄 刷新", callback_data: ADMIN_CALLBACK.USAGE_REFRESH },
      { text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]]
  };

  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 命令入口（/usage） */
export async function cmdUsage({ env, token, chatId }) {
  return renderUsagePanel(token, env, chatId, null);
}
