// ==========================================
// 📜 /guard：群规执法面板
//
// 与「管理控制台 → 📜 群规执法」是同一个面板：
// 引导式编辑群规、设置默认处置与禁言时长、开关执法、查看处置记录。
// 群规是按群的，所以请在目标群里使用。
// ==========================================

import { renderGuardPanel } from "../../admin/guard-panel.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";

/** /guard：打开群规执法面板 */
export async function cmdGuard({ env, token, chatId, uctx, isGroupCtx, ctx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }
  // 面板要长期停留在会话里，所以用新消息而不是自动删除
  await renderGuardPanel(token, env, chatId, null, uctx);
}
