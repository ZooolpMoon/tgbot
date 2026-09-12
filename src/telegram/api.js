// ==========================================
// 📡 Telegram API 封装
//
// 所有出站请求统一走这里：
//   • 429 / 5xx / 网络抖动自动退避重试（最多 3 次）
//   • 业务返回 ok:false（例如「消息内容未修改」）不重试，原样交回调用方
// ==========================================

import { randomFloat } from "../utils/random.js";

const BASE = (token) => `https://api.telegram.org/bot${token}`;

// 429 / 5xx / 网络抖动时的退避重试次数与最大等待时间
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 8000;

/** 等待若干毫秒（退避重试用） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从响应头或响应体中解析 Telegram 的 retry_after（秒） */
function parseRetryAfter(res, json) {
  const fromBody = Number(json?.parameters?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const header = res?.headers?.get?.("Retry-After");
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
  return 0;
}

/**
 * 计算退避时长：有 retry_after 就听 Telegram 的，否则指数退避 + 随机抖动，
 * 并且不超过 MAX_BACKOFF_MS。
 */
function backoffMs(attempt, retryAfterSec) {
  const base = retryAfterSec > 0
    ? retryAfterSec * 1000
    : 400 * Math.pow(2, attempt - 1);
  // 抖动使用加密随机数：既满足项目「不用 Math.random」的约定，
  // 也能避免多个请求在同一毫秒一起重试造成二次拥塞。
  const jitter = Math.floor(randomFloat() * 150);
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

/** 发送 JSON 请求；429 / 5xx / 网络错误按退避策略重试 */
async function postJSON(url, body) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      // 网络层错误：可重试
      lastError = e;
      if (attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, 0));
      continue;
    }

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }

    // Telegram 正常返回（含业务层面的 ok:false，例如「消息内容未修改」）
    if (res.ok && json) return json;

    const retryAfter = parseRetryAfter(res, json);
    const retryable =
      res.status === 429 ||
      res.status >= 500 ||
      Number(json?.error_code) === 429;

    if (!retryable || attempt >= MAX_ATTEMPTS) {
      if (json) return json;
      return { ok: false, error: { description: `HTTP ${res.status}` } };
    }

    console.warn(
      `[Telegram API] HTTP ${res.status}，${retryAfter > 0 ? `${retryAfter}s 后` : ""}第 ${attempt + 1} 次尝试`
    );
    await sleep(backoffMs(attempt, retryAfter));
  }

  console.error("[Telegram API] 请求最终失败:", lastError);
  return { ok: false, error: lastError };
}

/** 发送纯文本消息；parseMode 传 "HTML" 才会解析标签 */
export function sendMessage(token, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/sendMessage`, body);
}

/** 发送带 inline keyboard 的消息 */
export function sendMessageWithKeyboard(token, chatId, text, replyMarkup, parseMode = null) {
  const body = { chat_id: chatId, text, reply_markup: replyMarkup };
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/sendMessage`, body);
}

/** 发送消息并返回 message_id（群聊自动删除功能依赖它） */
export async function sendMessageGetId(token, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const json = await postJSON(`${BASE(token)}/sendMessage`, body);
  if (json && json.ok && json.result && json.result.message_id) {
    return json.result.message_id;
  }
  return null;
}

/** 编辑已有消息（可同时替换键盘） */
export function editMessageText(token, chatId, messageId, text, replyMarkup = null, parseMode = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/editMessageText`, body);
}

/** 回应按钮点击；showAlert=true 时以弹窗形式提示用户 */
export function answerCallback(token, callbackQueryId, text, showAlert = false) {
  return postJSON(`${BASE(token)}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

/** 删除消息（群聊清理与「关闭卡片」用） */
export function deleteMessage(token, chatId, messageId) {
  return postJSON(`${BASE(token)}/deleteMessage`, { chat_id: chatId, message_id: messageId });
}

/** 发送「正在输入」等聊天状态 */
export function sendChatAction(token, chatId, action) {
  return postJSON(`${BASE(token)}/sendChatAction`, { chat_id: chatId, action });
}

/**
 * 查询文件信息（知识库上传文档时用），返回 { file_path, file_size } 或 null。
 * Telegram 限制：机器人下载文件上限 20MB，超过会直接报错。
 */
export async function getFile(token, fileId) {
  const json = await postJSON(`${BASE(token)}/getFile`, { file_id: fileId });
  return json?.ok && json.result ? json.result : null;
}

/**
 * 下载文件并按 UTF-8 解码成文本。
 * @returns {Promise<string|null>} 超限或失败返回 null
 */
export async function downloadFileText(token, filePath, maxBytes = 512 * 1024) {
  if (!filePath) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new TextDecoder("utf-8").decode(buffer);
  } catch {
    return null;
  }
}
