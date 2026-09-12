// ==========================================
// 📋 管理员操作日志
// 记录「谁在什么时候改了什么」，便于审计。
// ==========================================

import { logError } from "../core/logger.js";

/**
 * 写入一条管理员操作日志。
 * 任何异常都不会影响主流程。
 */
export async function logAdminAction(env, { adminId, chatId = null, action, detail = "" }) {
  if (!env?.DB || !action) return;
  try {
    await env.DB.prepare(
      "INSERT INTO admin_logs (admin_id, chat_id, action, detail) VALUES (?, ?, ?, ?)"
    ).bind(
      String(adminId || "unknown"),
      chatId === null || chatId === undefined ? null : String(chatId),
      String(action),
      String(detail || "").slice(0, 500)
    ).run();
  } catch (e) {
    logError("写入管理员操作日志失败：", e);
  }
}
