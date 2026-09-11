// ==========================================
// /clear
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";

export async function cmdClear({ env, ctx, token, chatId, sceneKey, isGroupCtx }) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey).run();
  }
  await sendAutoDelete(token, chatId, "🧹 已清空对话历史！", null, isGroupCtx, ctx);
}