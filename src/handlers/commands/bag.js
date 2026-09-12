// ==========================================
// 🎒 /bag 我的背包
// 与商城首页里的「🎒 我的背包」按钮共用同一套渲染逻辑
// ==========================================

import { renderBag } from "../../shop/bag.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";

/** /bag 指令实现（仅私聊，由命令注册表拦截群聊） */
export async function cmdBag({ env, token, chatId, userKey, isGroupCtx, ctx }) {
  if (isGroupCtx) {
    await sendAutoDelete(token, chatId, "🎒 背包仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
    return;
  }
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 商城未启用", null, isGroupCtx, ctx);
    return;
  }
  await renderBag(token, env, chatId, userKey, null, 1);
}
