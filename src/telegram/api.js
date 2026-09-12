// ==========================================
// 📡 Telegram API 封装
// ==========================================

const BASE = (token) => `https://api.telegram.org/bot${token}`;

// 429 / 5xx / 网络抖动时的退避重试次数与最大等待时间
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 8000;

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

function backoffMs(attempt, retryAfterSec) {
  const base = retryAfterSec > 0
    ? retryAfterSec * 1000
    : 400 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

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

export function sendMessage(token, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/sendMessage`, body);
}

export function sendMessageWithKeyboard(token, chatId, text, replyMarkup, parseMode = null) {
  const body = { chat_id: chatId, text, reply_markup: replyMarkup };
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/sendMessage`, body);
}

export async function sendMessageGetId(token, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const json = await postJSON(`${BASE(token)}/sendMessage`, body);
  if (json && json.ok && json.result && json.result.message_id) {
    return json.result.message_id;
  }
  return null;
}

export function editMessageText(token, chatId, messageId, text, replyMarkup = null, parseMode = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  return postJSON(`${BASE(token)}/editMessageText`, body);
}

export function answerCallback(token, callbackQueryId, text, showAlert = false) {
  return postJSON(`${BASE(token)}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

export function deleteMessage(token, chatId, messageId) {
  return postJSON(`${BASE(token)}/deleteMessage`, { chat_id: chatId, message_id: messageId });
}

export function sendChatAction(token, chatId, action) {
  return postJSON(`${BASE(token)}/sendChatAction`, { chat_id: chatId, action });
}
