// ==========================================
// 🗑️ 群聊自动删除
// ==========================================

import { sendMessage, sendMessageGetId, deleteMessage } from "./api.js";
import { RULES } from "../config/constants.js";
import { logError } from "../core/logger.js";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendAutoDelete(token, chatId, text, parseMode, isGroupCtx, ctx) {
  if (!isGroupCtx) {
    return sendMessage(token, chatId, text, parseMode);
  }

  const sentId = await sendMessageGetId(token, chatId, text, parseMode);
  if (!sentId) return;

  const task = (async () => {
    try {
      await sleep(RULES.AUTO_DELETE_MS);
      await deleteMessage(token, chatId, sentId);
    } catch (e) {
      logError("自动删除失败:", e);
    }
  })();

  if (ctx && ctx.waitUntil) ctx.waitUntil(task);
  else await task;
}