// ==========================================
// 🗑️ 群聊自动删除
//
// 群聊里机器人自己发的消息，按「消息类型」决定保留多久（见 services/auto-delete.js）：
//   • 指令回执 / 执法回执 —— 默认 5 秒后删除，避免刷屏
//   • 卡片 / 公告 / AI 回复 —— 默认保留，管理员可在「🗑️ 自动删除」面板里改
// 私聊保持原样（不删除）。
//
// 删除动作放在 waitUntil 里异步执行，不阻塞当前请求。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, sendMessageGetId, deleteMessage } from "./api.js";
import { RULES } from "../config/constants.js";
import { logError } from "../core/logger.js";
import { defaultAutoDeleteSec, getAutoDeleteSeconds } from "../services/auto-delete.js";

/** 简单的 sleep（供自动删除与群发节流共用） */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送消息；群聊场景下按消息类型设置的时长自动删除。
 *
 * 参数里的 ctx 有两种形态——
 *   1. Worker 原生 ctx（带 waitUntil）
 *   2. 指令处理里的复合上下文（原生 ctx 挂在 .ctx 上，另带 env / sceneKey）
 * 复合上下文能直接提供 env 与 sceneKey；只传原生 ctx 时请在 options 里补上。
 *
 * @param {object} [options]
 * @param {string} [options.kind] 消息类型（cmd / guard / card / ai / notice）
 * @param {object} [options.env] 需要查设置时用
 * @param {string} [options.sceneKey] 场景键（群聊为 group:<群ID>）
 * @param {number} [options.delayMs] 直接指定延迟（毫秒），跳过设置查询
 * @param {object} [options.keyboard] inline keyboard，带按钮的卡片
 */
export async function sendAutoDelete(token, chatId, text, parseMode, isGroupCtx, ctx, options = {}) {
  const { kind = "cmd", keyboard = null } = options || {};
  if (!isGroupCtx) {
    // 私聊不删除，但键盘不能丢
    return keyboard
      ? sendMessageWithKeyboard(token, chatId, text, keyboard, parseMode)
      : sendMessage(token, chatId, text, parseMode);
  }

  const env = options.env || ctx?.env || null;
  const sceneKey = options.sceneKey || ctx?.sceneKey || null;

  let delayMs;
  if (Number.isFinite(options.delayMs)) {
    delayMs = Math.max(0, Number(options.delayMs));
  } else {
    const sec = env?.DB
      ? await getAutoDeleteSeconds(env, sceneKey, kind)
      : defaultAutoDeleteSec(kind);
    delayMs = Math.max(0, Number(sec) || 0) * 1000;
  }

  // 0 秒 = 不删除；此时只需要把消息发出去（带按钮时也要保留键盘）
  if (!(delayMs > 0)) {
    return sendMessageGetId(token, chatId, text, parseMode, keyboard);
  }

  const sentId = await sendMessageGetId(token, chatId, text, parseMode, keyboard);
  if (!sentId) return;

  const task = (async () => {
    try {
      await sleep(delayMs);
      await deleteMessage(token, chatId, sentId);
    } catch (e) {
      logError("自动删除失败:", e);
    }
  })();

  const workerCtx = typeof ctx?.waitUntil === "function" ? ctx : ctx?.ctx;
  if (typeof workerCtx?.waitUntil === "function") workerCtx.waitUntil(task);
  else await task;
}

/** 兼容旧调用：默认的自动删除时长（毫秒） */
export const AUTO_DELETE_MS = RULES.AUTO_DELETE_MS;
