// ==========================================
// 📚 /kb 知识库管理
//
// 与「管理控制台 → 📚 知识库」是同一套面板，方便管理员直接用指令打开。
// 作用域按会话类型自动判定：私聊 = 全局知识库，群聊 = 本群知识库。
// ==========================================

import { renderKnowledgeHome } from "../../admin/knowledge.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";

/** /kb：打开知识库面板（新发一条消息，不自动删除，方便连续操作） */
export async function cmdKb({ env, token, chatId, uctx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, false);
    return;
  }
  await renderKnowledgeHome(token, env, chatId, null, uctx);
}
