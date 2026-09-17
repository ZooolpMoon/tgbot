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

/**
 * 发送消息并返回 message_id（群聊自动删除功能依赖它）。
 * 可选 replyMarkup：带按钮的卡片也要能自动删除时用。
 */
export async function sendMessageGetId(token, chatId, text, parseMode = null, replyMarkup = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
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

/**
 * 下载文件原始字节（.docx / .pdf 这类需要二进制解析的文件用）。
 * @returns {Promise<ArrayBuffer|null>} 超限或失败返回 null
 */
export async function downloadFileBuffer(token, filePath, maxBytes = 512 * 1024) {
  if (!filePath) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return buffer;
  } catch {
    return null;
  }
}

// ==========================================
// 🛡️ 群管理能力（群规执法用）
// 注意：机器人在群里必须是管理员且拥有 can_restrict_members 权限，
// 否则 Telegram 会返回 ok:false —— 调用方需要处理「无权限」的情况。
// ==========================================

/** 查询成员信息（判断是否群管理员、是否已被禁言等） */
export function getChatMember(token, chatId, userId) {
  return postJSON(`${BASE(token)}/getChatMember`, { chat_id: chatId, user_id: userId });
}

/** 查询机器人自身信息（可用于确认 bot 的身份） */
export function getMe(token) {
  return postJSON(`${BASE(token)}/getMe`, {});
}

/** 查询会话信息（群名、类型等）；机器人已被移出的群会返回 ok:false */
export function getChat(token, chatId) {
  return postJSON(`${BASE(token)}/getChat`, { chat_id: chatId });
}

/**
 * 设置群内普通成员的标签（Telegram Bot API 9.1+）。
 * 机器人必须是该群管理员，并勾选「管理标签」（`can_manage_tags`）权限；
 * 标签 0~16 字符、不允许 emoji；传空字符串表示清除标签。
 */
export function setChatMemberTag(token, chatId, userId, tag = "") {
  return postJSON(`${BASE(token)}/setChatMemberTag`, {
    chat_id: chatId, user_id: userId, tag: String(tag || "")
  });
}

/**
 * 封禁 / 踢出成员。
 * @param {number} [untilDate] Unix 秒；0 表示永久，>0 表示到期自动解封
 * @param {boolean} [revokeMessages] 是否同时删除该成员的消息
 */
export function banChatMember(token, chatId, userId, untilDate = 0, revokeMessages = false) {
  const body = { chat_id: chatId, user_id: userId };
  if (untilDate > 0) body.until_date = untilDate;
  if (revokeMessages) body.revoke_messages = true;
  return postJSON(`${BASE(token)}/banChatMember`, body);
}

/** 解除群封禁（配合 banChatMember 可实现「踢出但允许重新加入」） */
export function unbanChatMember(token, chatId, userId, onlyIfBanned = true) {
  return postJSON(`${BASE(token)}/unbanChatMember`, {
    chat_id: chatId, user_id: userId, only_if_banned: onlyIfBanned
  });
}

/** 发送权限模板：禁言时全部置否，解除禁言时全部放开 */
function mutePermissions(canSend) {
  return {
    can_send_messages: canSend,
    can_send_audios: canSend,
    can_send_documents: canSend,
    can_send_photos: canSend,
    can_send_videos: canSend,
    can_send_video_notes: canSend,
    can_send_voice_notes: canSend,
    can_send_polls: canSend,
    can_send_other_messages: canSend,
    can_add_web_page_previews: canSend,
    can_change_info: canSend,
    can_invite_users: canSend,
    can_pin_messages: canSend
  };
}

/**
 * 禁言 / 解除禁言。
 * @param {number} untilDate Unix 秒；0 表示永久禁言（Telegram 语义）
 */
export function restrictChatMember(token, chatId, userId, { mute = true, untilDate = 0, useIndependent = false } = {}) {
  const body = {
    chat_id: chatId,
    user_id: userId,
    permissions: mutePermissions(!mute)
  };
  if (mute && untilDate > 0) body.until_date = untilDate;
  if (useIndependent) body.use_independent_chat_permissions = true;
  return postJSON(`${BASE(token)}/restrictChatMember`, body);
}

// ==========================================
// ⌨️ 输入框命令菜单（BotCommand）
// 设置后用户在聊天框输入「/」就能看到指令列表，不用记名字。
// ==========================================

/**
 * 设置命令菜单。
 * @param {Array<{command:string, description:string}>} commands 名称不要带 "/"
 * @param {object} [scope] BotCommandScope，例如 { type: "all_group_chats" }
 * @param {string} [languageCode] 留空表示默认语言
 */
export function setMyCommands(token, commands, scope = null, languageCode = "") {
  const body = { commands };
  if (scope) body.scope = scope;
  if (languageCode) body.language_code = languageCode;
  return postJSON(`${BASE(token)}/setMyCommands`, body);
}

/** 查询当前命令菜单（排查用） */
export function getMyCommands(token, scope = null) {
  const body = {};
  if (scope) body.scope = scope;
  return postJSON(`${BASE(token)}/getMyCommands`, body);
}

/** 删除某个作用域的命令菜单 */
export function deleteMyCommands(token, scope = null) {
  const body = {};
  if (scope) body.scope = scope;
  return postJSON(`${BASE(token)}/deleteMyCommands`, body);
}

// ==========================================
// 🔗 Webhook 管理（自愈巡检用）
// 见 services/webhook.js：地址被清空时靠这两个接口自己修回来。
// ==========================================

/** 查询 webhook 状态（含投递失败原因 last_error_message） */
export function getWebhookInfo(token) {
  return postJSON(`${BASE(token)}/getWebhookInfo`, {});
}

/**
 * 设置 webhook。
 * @param {string} url 必须 https，端口只能是 443 / 80 / 88 / 8443
 * @param {{secretToken?:string, dropPendingUpdates?:boolean, maxConnections?:number}} [opts]
 *        secretToken 会以 X-Telegram-Bot-Api-Secret-Token 头回传，用来校验来源
 */
export function setWebhook(token, url, { secretToken = "", dropPendingUpdates = false, maxConnections = 0 } = {}) {
  const body = { url };
  if (secretToken) body.secret_token = secretToken;
  if (dropPendingUpdates) body.drop_pending_updates = true;
  if (maxConnections > 0) body.max_connections = maxConnections;
  return postJSON(`${BASE(token)}/setWebhook`, body);
}
