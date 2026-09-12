// ==========================================
// 📖 /help
// 文案由命令注册表自动生成（见 commands/registry.js），
// 避免「加了命令忘了写帮助」。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { buildHelpText } from "./registry.js";

/** /help：按身份与场景渲染指令列表（群聊里 5 秒后自动删除） */
export async function cmdHelp({ token, chatId, isMaster, isGroupCtx, ctx }) {
  const text = buildHelpText({ isMaster, isGroupCtx });
  await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx);
}
