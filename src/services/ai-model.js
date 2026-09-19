// ==========================================
// 🤖 模型调用与回退（v3.10.0）
//
// 从 handlers/ai.js 抽出来：日报（services/summary.js）与长期记忆
// （services/memory.js）也要调模型，而 services 反过来 import handlers 会绕出
// 一条别扭的依赖（handlers 本来就依赖 services）。这里放中立的一层，
// 三个调用方都走它，回退链与用量统计也就只有一份。
// ==========================================

import { AI_MODELS, AI_MAX_TOKENS } from "../config/constants.js";
import { logError, logWarn } from "../core/logger.js";
import { countUsage, METRIC, modelMetric } from "./usage.js";

/** 解析可用模型列表：env.AI_MODELS（逗号分隔）优先，其次内置回退链 */
export function resolveModels(env) {
  const raw = env?.AI_MODELS ? String(env.AI_MODELS) : "";
  const custom = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length > 0 ? custom : AI_MODELS;
}

/** 从 Workers AI 的返回体里取回复文本（兼容不同模型的结构差异） */
export function extractReplyText(res) {
  // Workers AI 不同模型的返回结构略有差异，这里做兼容取值
  if (!res) return "";
  const text = res.response || res.choices?.[0]?.message?.content || res.result?.response || "";
  return typeof text === "string" ? text.trim() : "";
}

/**
 * 依次尝试主模型与备选模型。
 * 主模型报错或返回空内容时自动切换下一个，全部失败才判定为异常。
 * @returns {Promise<{text:string, model:string|null, fallback:boolean}>}
 */
export async function runAIWithFallback(env, messages, { maxTokens = AI_MAX_TOKENS } = {}) {
  const models = resolveModels(env);
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await env.AI.run(model, { messages, max_tokens: maxTokens });
      const text = extractReplyText(res);
      if (text) {
        // 📊 用量统计（内存累加，请求结束时统一落库）
        countUsage(env, METRIC.AI_CALL);
        countUsage(env, modelMetric(model));
        if (i > 0) countUsage(env, METRIC.AI_FALLBACK);
        return { text, model, fallback: i > 0 };
      }
      lastError = new Error("模型返回空内容");
    } catch (e) {
      lastError = e;
    }
    countUsage(env, METRIC.AI_FAIL);
    logWarn(`模型 ${model} 调用失败${i < models.length - 1 ? `，尝试回退到 ${models[i + 1]}` : ""}：`, lastError?.message || lastError);
  }

  logError("所有 AI 模型均调用失败：", lastError);
  return { text: "", model: null, fallback: false };
}

/**
 * 一次性问答的便捷封装（日报、长期记忆用）。
 * 失败返回空串 —— 调用方据此决定「保留旧数据 / 跳过本次」，
 * 不要把空串当成有效摘要写进库。
 */
export async function runTextCompletion(env, { system, user, maxTokens = 512 }) {
  if (!env?.AI) return "";
  const messages = [];
  if (system) messages.push({ role: "system", content: String(system) });
  messages.push({ role: "user", content: String(user ?? "") });
  const { text } = await runAIWithFallback(env, messages, { maxTokens });
  return text || "";
}
