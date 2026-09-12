// ==========================================
// 🗑️ 群聊自动删除
//
// 群聊里指令类消息 5 秒后自动删除，避免刷屏；私聊保持原样。
// 删除动作放在 waitUntil 里异步执行，不阻塞当前请求。
// ==========================================

import { sendMessage, sendMessageGetId, deleteMessage } from "./api.js";
import { RULES } from "../config/constants.js";
import { logError } from "../core/logger.js";

/** 简单的 sleep（供自动删除与群发节流共用） */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送消息；群聊场景下 5 秒后自动删除。
 *
 * 注意：调用方传进来的 ctx 有两种形态——
 *   1. Worker 原生 ctx（带 waitUntil）
 *   2. 指令处理里的复合上下文（原生 ctx 挂在 .ctx 上）
 * 这里统一解析，避免走成「同步等待 5 秒」拖慢整条请求。
 */
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

  const workerCtx = typeof ctx?.waitUntil === "function" ? ctx : ctx?.ctx;
  if (typeof workerCtx?.waitUntil === "function") workerCtx.waitUntil(task);
  else await task;
}
