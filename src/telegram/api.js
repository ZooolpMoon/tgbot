// ==========================================
// 📡 Telegram API 封装
// ==========================================

const BASE = (token) => `https://api.telegram.org/bot${token}`;

async function postJSON(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error("[Telegram API] fetch 失败:", e);
    return { ok: false, error: e };
  }
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