// ==========================================
// 🧠 AI 上下文裁剪
// 独立成模块便于测试（原先内联在 handlers/ai.js 里）
// ==========================================

import { RULES } from "../config/constants.js";

/** 历史字符预算：env.AI_HISTORY_MAX_CHARS 可覆盖，小于 500 视为无效 */
export function resolveHistoryBudget(env) {
  const n = Number(env?.AI_HISTORY_MAX_CHARS);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : RULES.HISTORY_MAX_CHARS;
}

/** 单条消息超长时截断 */
export function clampMessage(content, maxChars = RULES.HISTORY_MESSAGE_MAX_CHARS) {
  const text = typeof content === "string" ? content : String(content ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…（已截断）";
}

/**
 * 从最新消息往前累加，直到超出字符预算为止。
 * 最新一条永远保留（哪怕它本身超预算，只是会被截断过），保证上下文不为空。
 */
export function trimHistory(list, maxChars = RULES.HISTORY_MAX_CHARS) {
  const normalized = (list || [])
    .filter((m) => m && typeof m.content === "string" && m.content && m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: clampMessage(m.content)
    }));

  const kept = [];
  let used = 0;
  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i];
    const cost = msg.content.length + 8;
    if (kept.length > 0 && used + cost > maxChars) break;
    kept.unshift(msg);
    used += cost;
  }
  return kept;
}
