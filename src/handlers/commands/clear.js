// ==========================================
// /clear
// 只清空「当前场景」的对话记忆，不影响积分与任务进度。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";

/** /clear 指令实现 */
export async function cmdClear({ env, ctx, token, chatId, sceneKey, isGroupCtx }) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey).run();
  }
  await sendAutoDelete(token, chatId, "🧹 已清空对话历史！", null, isGroupCtx, ctx);
}
