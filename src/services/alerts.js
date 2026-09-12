// ==========================================
// 🚨 异常告警（v3.0.0）
//
// 以前 Worker 里出错只在日志 / wrangler tail 里能看到，管理员（尤其是用手机看群的）
// 根本不知道机器人半夜炸了。这里做一件事：**把异常私聊给管理员**。
//
// 防刷：
//   • 同一个「标题 + 摘要」5 分钟内只发一次（isolate 内存去重）
//   • 发送失败静默（不能在告警里再抛异常）
// ==========================================

import { sendMessage } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { resolveAdminChatId } from "../shop/notify.js";
import { logError } from "../core/logger.js";

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEDUPE_CACHE = new Map();

/** 摘要化：去掉数字与路径噪声，让「同类错误」能命中同一条 */
function fingerprint(title, detail) {
  return `${title}|${String(detail || "").replace(/\d+/g, "#").slice(0, 120)}`;
}

/**
 * 给管理员发一条异常告警（不保证送达，也不会抛异常）。
 * @param {object} env
 * @param {string} token
 * @param {{title:string, detail?:string, context?:string}} info
 * @returns {Promise<boolean>} 是否真的发出去了
 */
export async function alertAdmin(env, token, { title, detail = "", context = "" } = {}) {
  try {
    if (!token || !title) return false;
    const chatId = resolveAdminChatId(env);
    if (!chatId) return false;

    const key = fingerprint(title, detail);
    const last = DEDUPE_CACHE.get(key) || 0;
    if (Date.now() - last < DEDUPE_WINDOW_MS) return false;
    if (DEDUPE_CACHE.size > 100) DEDUPE_CACHE.clear();
    DEDUPE_CACHE.set(key, Date.now());

    const text =
      `🚨 <b>机器人异常</b>\n` +
      `-------------------------\n` +
      `📌 <b>${escapeHtml(title)}</b>\n` +
      (detail ? `💬 ${escapeHtml(String(detail).slice(0, 400))}\n` : ``) +
      (context ? `📍 ${escapeHtml(String(context).slice(0, 200))}\n` : ``) +
      `\n<i>同类问题 5 分钟内只提醒一次；详细信息见 wrangler tail / Cloudflare 日志。</i>`;

    const res = await sendMessage(token, chatId, text, "HTML");
    return Boolean(res && res.ok !== false);
  } catch (e) {
    logError("发送异常告警失败：", e);
    return false;
  }
}

/** 测试用：清掉去重记录 */
export function resetAlertCache() {
  DEDUPE_CACHE.clear();
}
