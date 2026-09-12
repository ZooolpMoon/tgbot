// ==========================================
// 📖 /help
// 文案由命令注册表自动生成（见 commands/registry.js），
// 避免「加了命令忘了写帮助」。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { buildHelpText } from "./registry.js";
import { isGroupAdmin } from "../../services/guard.js";
import { logError } from "../../core/logger.js";

/**
 * /help：按身份与场景渲染指令列表（群聊里 5 秒后自动删除）。
 *
 * 必须把 role 传下去：buildHelpText 是按 capability 裁的，不传 role 的话
 * 除了 owner 之外的所有人都会被当成普通用户（管理员/执法员看不到自己那部分）。
 * 群里的「本群管理员」没有机器人角色，但能用执法指令，所以额外查一次 Telegram。
 */
export async function cmdHelp({ env, token, chatId, isMaster, isGroupCtx, role, uctx, ctx }) {
  let groupAdmin = false;
  if (isGroupCtx && !role && env?.DB && uctx?.userId) {
    try {
      groupAdmin = await isGroupAdmin(token, chatId, uctx.userId);
    } catch (e) {
      logError("读取本群管理员身份失败：", e);
    }
  }

  const text = buildHelpText({ isMaster, isGroupCtx, role, groupAdmin });
  await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx);
}
