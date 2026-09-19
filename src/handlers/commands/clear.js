// ==========================================
// /clear
// 只清空「当前场景」的对话记忆，不影响积分与任务进度。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { clearMemory } from "../../services/memory.js";

/** /clear 指令实现 */
export async function cmdClear({ env, ctx, token, chatId, sceneKey, isGroupCtx }) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey).run();
    // 画像也是「记忆」的一部分：不清掉的话，用户清空历史后机器人照样记得他
    await clearMemory(env, sceneKey);
  }
  await sendAutoDelete(token, chatId, "🧹 已清空对话历史！", null, isGroupCtx, ctx);
}
