// ==========================================
// 🤖 AI 对话处理
//
// 计费顺序（必须保证「要么都成功，要么都回滚」）：
//   1. 频率限制 → 2. 占今日额度 → 3. 扣积分 → 4. 调模型
// 第 4 步失败时，第 2、3 步会通过 rollback() 全额退回。
// ==========================================

import { sendMessage, sendChatAction } from "../telegram/api.js";
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { AI_MODELS, AI_MAX_TOKENS, POINTS, RULES } from "../config/constants.js";
import { ERR } from "../config/messages.js";
import { getDateKey } from "../services/time.js";
import { reserveDailyQuota, refundDailyQuota } from "../services/quota.js";
import { tryDeductPoints, refundPoint, logPointChange } from "../services/points.js";
import { resolveHistoryBudget, clampMessage, trimHistory } from "../services/history.js";
import { completeTask } from "../services/tasks.js";
import { logError, logWarn } from "../core/logger.js";

/**
 * AI 对话主流程。
 * 顺序：频率限制 → 占额度 → 扣积分 → 组装上下文 → 调模型 → 记流水 → 落库历史 → 触发任务。
 * @param {object} params 由 handlers/message.js 传入的上下文
 */
export async function handleAIRequest({
  env, ctx, token, chatId, userKey, sceneKey, isGroupCtx, isMaster,
  firstName, userText, userConfig
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStr = getDateKey(env);
  const ownerName = env.BOT_OWNER_NAME ? String(env.BOT_OWNER_NAME).trim() : "管理员";
  // 未配置时不写死任何账号，由部署方通过 BOT_OWNER_USERNAME 指定
  const ownerUsername = env.BOT_OWNER_USERNAME ? String(env.BOT_OWNER_USERNAME).trim() : "admin";

  let quotaReserved = false;
  let pointsCharged = false;
  /** 扣分后余额（用于写流水，避免再次查库导致余额与实际不符） */
  let balanceAfterCharge = null;
  let chargedDateStr = null;
  const previousLastMsgTime = userConfig.lastMsgTime;

  // 频率限制
  if (userConfig.rateLimitSec > 0 && userConfig.lastMsgTime > 0) {
    const passed = nowSec - userConfig.lastMsgTime;
    if (passed < userConfig.rateLimitSec) {
      await sendAutoDelete(token, chatId, ERR.RATE_LIMIT(userConfig.rateLimitSec - passed), null, isGroupCtx, ctx);
      return;
    }
  }

  // 占额度
  if (env.DB && userConfig.maxDaily !== -1) {
    if (userConfig.maxDaily <= 0) {
      await sendAutoDelete(token, chatId, ERR.QUOTA_ZERO, null, isGroupCtx, ctx);
      return;
    }
    const ok = await reserveDailyQuota(env, sceneKey, todayStr, userConfig.maxDaily);
    if (!ok) {
      await sendAutoDelete(token, chatId, ERR.QUOTA_EMPTY(userConfig.maxDaily), null, isGroupCtx, ctx);
      return;
    }
    quotaReserved = true;
    chargedDateStr = todayStr;
  }

  // 扣分
  if (env.DB) {
    const balance = await tryDeductPoints(env, userKey, POINTS.AI_COST);
    if (balance === null) {
      if (quotaReserved) {
        await refundDailyQuota(env, sceneKey, chargedDateStr || todayStr);
        quotaReserved = false;
      }
      await sendAutoDelete(token, chatId, ERR.POINTS_EMPTY, null, isGroupCtx, ctx);
      return;
    }
    balanceAfterCharge = balance;
    pointsCharged = true;
  } else if (userConfig.points < POINTS.AI_COST) {
    await sendAutoDelete(token, chatId, ERR.POINTS_EMPTY, null, isGroupCtx, ctx);
    return;
  } else {
    pointsCharged = true;
  }

  // 更新 last_msg_time
  if (env.DB) {
    await env.DB.prepare(
      "UPDATE user_scenes SET last_msg_time = ?, updated_at = CURRENT_TIMESTAMP WHERE scene_key = ?"
    ).bind(nowSec, sceneKey).run();
  }

  // 构造 system prompt
  let baseSystemPrompt = isMaster
    ? `你是一个高效专业的 AI 助手。\n【对话者身份确认】：\n1. 当前与你对话的用户是你的管理员 ${ownerName}。\n2. 你是 AI 助手，绝不可自称为 ${ownerName}。\n3. 当用户问“我是谁”时回答“你是管理员 ${ownerName}”；当用户问“你是谁”时回答“我是你的 AI 助手”。\n4. 称呼对方为【管理员】，回答要简洁干练、直奔主题。`
    : `你是一个通用的 AI 助手。\n【访客模式】：\n1. 你是管理员 @${ownerUsername} 拥有的个人 AI 助手。\n2. 当访客问“你是谁”或“谁是你的管理员”时，清晰说明你是 ${ownerName} 的 AI 助手。\n3. 绝不泄露关于管理员的敏感隐私。`;

  baseSystemPrompt += `\n【语言偏好】：优先使用 ${userConfig.lang === "en" ? "English" : "中文"}。`;
  if (isGroupCtx) {
    baseSystemPrompt += `\n【场景提示】：当前处于群聊环境，用户 ${firstName} 主动 @ 了你（或使用了指令），请直接回应他，回复简洁。`;
  }
  if (userConfig.customPrompt) {
    baseSystemPrompt += `\n【用户个性化要求】：${userConfig.customPrompt}`;
  }

  // 组装消息：按字符预算截断历史，避免长对话超出模型上下文
  const historyBudget = resolveHistoryBudget(env);
  let historyMessages = [];
  if (env.DB) {
    const historyRow = await env.DB.prepare(
      "SELECT messages FROM chat_history WHERE scene_key = ?"
    ).bind(sceneKey).first();
    if (historyRow?.messages) {
      try {
        const parsed = JSON.parse(historyRow.messages);
        if (Array.isArray(parsed)) {
          historyMessages = trimHistory(parsed, historyBudget);
        }
      } catch (e) {
        logError("历史消息解析失败：", e);
      }
    }
  }
  historyMessages.push({
    role: "user",
    content: clampMessage(userText, RULES.HISTORY_MESSAGE_MAX_CHARS)
  });
  const messages = [{ role: "system", content: baseSystemPrompt }, ...historyMessages];

  const typingTask = sendChatAction(token, chatId, "typing");
  if (ctx?.waitUntil) ctx.waitUntil(typingTask);
  else await typingTask;

  if (!env.AI) {
    await rollback(env, pointsCharged, quotaReserved, userKey, sceneKey, chargedDateStr || todayStr, previousLastMsgTime);
    await sendAutoDelete(token, chatId, ERR.AI_NOT_BOUND, null, isGroupCtx, ctx);
    return;
  }

  const { text: replyText, model: usedModel, fallback } = await runAIWithFallback(env, messages);

  if (!replyText) {
    await rollback(env, pointsCharged, quotaReserved, userKey, sceneKey, chargedDateStr || todayStr, previousLastMsgTime);
    await sendAutoDelete(token, chatId, ERR.AI_ERROR, null, isGroupCtx, ctx);
    return;
  }
  if (fallback) logWarn(`主模型不可用，已回退到 ${usedModel}`);

  // 记录积分流水（扣分）
  if (env.DB && pointsCharged) {
    // 直接用扣分时返回的余额，避免中间又被别的请求改动导致流水余额对不上
    const balance = Number.isFinite(balanceAfterCharge) ? balanceAfterCharge : 0;
    await logPointChange(env, userKey, -POINTS.AI_COST, balance, "AI 对话消耗");
  }

  // 存储历史
  const saveHistoryTask = (async () => {
    if (!env.DB) return;
    if (userConfig.maxDaily === -1) {
      await env.DB.prepare(
        "INSERT INTO daily_stats (scene_key, date_str, count) VALUES (?, ?, 1) ON CONFLICT(scene_key, date_str) DO UPDATE SET count = count + 1"
      ).bind(sceneKey, todayStr).run();
    }
    // 不改动已发送给模型的 messages，单独构造待落库的历史
    const nonSystem = [...messages.filter((m) => m.role !== "system"), { role: "assistant", content: replyText }];
    // 双重限制：条数上限 + 字符上限
    const byCount = nonSystem.slice(-RULES.HISTORY_LIMIT);
    const trimmed = [messages[0], ...trimHistory(byCount, historyBudget)];
    await env.DB.prepare(
      "INSERT INTO chat_history (scene_key, messages, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(scene_key) DO UPDATE SET messages = EXCLUDED.messages, updated_at = CURRENT_TIMESTAMP"
    ).bind(sceneKey, JSON.stringify(trimmed)).run();
  })();
  if (ctx?.waitUntil) ctx.waitUntil(saveHistoryTask);
  else await saveHistoryTask;

  await sendMessage(token, chatId, replyText);

  // 成功回复后记一次「和 AI 聊一次」任务（失败时不计数）
  await completeTask(env, userKey, "chat", { sceneKey, chatId, token });
}

// ==========================================
// 🤖 模型回退与上下文裁剪
// ==========================================

/** 解析可用模型列表：env.AI_MODELS（逗号分隔）优先，其次内置回退链 */
function resolveModels(env) {
  const raw = env?.AI_MODELS ? String(env.AI_MODELS) : "";
  const custom = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length > 0 ? custom : AI_MODELS;
}

/** 从 Workers AI 的返回体里取回复文本（兼容不同模型的结构差异） */
function extractReplyText(res) {
  // Workers AI 不同模型的返回结构略有差异，这里做兼容取值
  if (!res) return "";
  const text = res.response || res.choices?.[0]?.message?.content || res.result?.response || "";
  return typeof text === "string" ? text.trim() : "";
}

/**
 * 依次尝试主模型与备选模型。
 * 主模型报错或返回空内容时自动切换下一个，全部失败才判定为异常。
 */
async function runAIWithFallback(env, messages) {
  const models = resolveModels(env);
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await env.AI.run(model, { messages, max_tokens: AI_MAX_TOKENS });
      const text = extractReplyText(res);
      if (text) {
        return { text, model, fallback: i > 0 };
      }
      lastError = new Error("模型返回空内容");
    } catch (e) {
      lastError = e;
    }
    logWarn(`模型 ${model} 调用失败${i < models.length - 1 ? `，尝试回退到 ${models[i + 1]}` : ""}：`, lastError?.message || lastError);
  }

  logError("所有 AI 模型均调用失败：", lastError);
  return { text: "", model: null, fallback: false };
}

/** 模型调用失败时回滚：退积分、退额度、还原上次发言时间 */
async function rollback(env, pointsCharged, quotaReserved, userKey, sceneKey, dateStr, prevLastMsgTime) {
  if (!env.DB) return;
  try {
    if (pointsCharged) await refundPoint(env, userKey, POINTS.AI_COST, "AI 异常自动退款");
    if (quotaReserved) await refundDailyQuota(env, sceneKey, dateStr);
    await env.DB.prepare(
      "UPDATE user_scenes SET last_msg_time = ?, updated_at = CURRENT_TIMESTAMP WHERE scene_key = ?"
    ).bind(prevLastMsgTime, sceneKey).run();
  } catch (e) {
    logError("回滚失败:", e);
  }
}
