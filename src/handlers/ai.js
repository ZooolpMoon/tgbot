// ==========================================
// 🤖 AI 对话处理
// ==========================================

import { sendMessage, sendChatAction } from "../telegram/api.js";
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { AI_MODEL, AI_MAX_TOKENS, POINTS, RULES } from "../config/constants.js";
import { ERR } from "../config/messages.js";
import { getDateKey } from "../services/time.js";
import { reserveDailyQuota, refundDailyQuota } from "../services/quota.js";
import { tryDeductPoints, refundPoint, logPointChange } from "../services/points.js";
import { logError } from "../core/logger.js";

export async function handleAIRequest({
  env, ctx, token, chatId, userKey, sceneKey, isGroupCtx, isMaster,
  firstName, userText, userConfig
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStr = getDateKey(env);

  let quotaReserved = false;
  let pointsCharged = false;
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
    ? "你是一个高效专业的 AI 助手。\n【对话者身份确认】：\n1. 当前与你对话的用户是你的管理员 @Zooolp_admin。\n2. 你是 AI 助手，绝不可自称为 @Zooolp_admin。\n3. 当用户问“我是谁”时回答“你是管理员 @Zooolp_admin”；当用户问“你是谁”时回答“我是你的 AI 助手”。\n4. 称呼对方为【管理员】，回答要简洁干练、直奔主题。"
    : "你是一个通用的 AI 助手。\n【访客模式】：\n1. 你是管理员 @Zooolp_admin 拥有的个人 AI 助手。\n2. 当访客问“你是谁”或“谁是你的管理员”时，清晰说明你是 @Zooolp_admin 的 AI 助手。\n3. 绝不泄露关于管理员的敏感隐私。";

  baseSystemPrompt += `\n【语言偏好】：优先使用 ${userConfig.lang === "en" ? "English" : "中文"}。`;
  if (isGroupCtx) {
    baseSystemPrompt += `\n【场景提示】：当前处于群聊环境，用户 ${firstName} 主动 @ 了你（或使用了指令），请直接回应他，回复简洁。`;
  }
  if (userConfig.customPrompt) {
    baseSystemPrompt += `\n【用户个性化要求】：${userConfig.customPrompt}`;
  }

  // 组装消息
  let messages = [{ role: "system", content: baseSystemPrompt }];
  if (env.DB) {
    const historyRow = await env.DB.prepare(
      "SELECT messages FROM chat_history WHERE scene_key = ?"
    ).bind(sceneKey).first();
    if (historyRow?.messages) {
      try {
        const parsed = JSON.parse(historyRow.messages);
        if (Array.isArray(parsed)) {
          messages = messages.concat(parsed.filter((m) => m && m.role !== "system"));
        }
      } catch (e) {
        logError("历史消息解析失败：", e);
      }
    }
  }
  messages.push({ role: "user", content: userText });

  ctx.waitUntil(sendChatAction(token, chatId, "typing"));

  if (!env.AI) {
    await rollback(env, pointsCharged, quotaReserved, userKey, sceneKey, chargedDateStr || todayStr, previousLastMsgTime);
    await sendAutoDelete(token, chatId, ERR.AI_NOT_BOUND, null, isGroupCtx, ctx);
    return;
  }

  let aiResponse;
  try {
    aiResponse = await env.AI.run(AI_MODEL, { messages, max_tokens: AI_MAX_TOKENS });
  } catch (aiErr) {
    logError("Workers AI 调用失败：", aiErr);
    await rollback(env, pointsCharged, quotaReserved, userKey, sceneKey, chargedDateStr || todayStr, previousLastMsgTime);
    await sendAutoDelete(token, chatId, ERR.AI_ERROR, null, isGroupCtx, ctx);
    return;
  }

  const replyText = aiResponse.response || aiResponse.choices?.[0]?.message?.content || "AI 未能生成回复";

  // 记录积分流水（扣分）
  if (env.DB && pointsCharged) {
    const cur = await env.DB.prepare("SELECT points FROM users WHERE user_key = ?").bind(userKey).first();
    const balance = Number(cur?.points);
    await logPointChange(env, userKey, -POINTS.AI_COST, Number.isFinite(balance) ? balance : 0, "AI 对话消耗");
  }

  // 存储历史
  ctx.waitUntil((async () => {
    if (!env.DB) return;
    if (userConfig.maxDaily === -1) {
      await env.DB.prepare(
        "INSERT INTO daily_stats (scene_key, date_str, count) VALUES (?, ?, 1) ON CONFLICT(scene_key, date_str) DO UPDATE SET count = count + 1"
      ).bind(sceneKey, todayStr).run();
    }
    messages.push({ role: "assistant", content: replyText });
    const nonSystem = messages.filter((m) => m.role !== "system");
    const trimmed = [messages[0], ...nonSystem.slice(-RULES.HISTORY_LIMIT)];
    await env.DB.prepare(
      "INSERT INTO chat_history (scene_key, messages, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(scene_key) DO UPDATE SET messages = EXCLUDED.messages, updated_at = CURRENT_TIMESTAMP"
    ).bind(sceneKey, JSON.stringify(trimmed)).run();
  })());

  await sendMessage(token, chatId, replyText);
}

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