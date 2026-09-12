// ==========================================
// 📜 /orders 我的订单
// 与商城内的「我的订单」共用同一套渲染逻辑（含取消并退款按钮）
// ==========================================

import { renderMyOrders } from "../../shop/index.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";

export async function cmdOrders({ env, token, chatId, userKey, isGroupCtx, ctx }) {
  if (isGroupCtx) {
    await sendAutoDelete(
      token, chatId,
      "🛒 订单功能仅支持<b>私聊</b>使用。",
      "HTML", isGroupCtx, ctx
    );
    return;
  }
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 商城未启用", null, isGroupCtx, ctx);
    return;
  }

  await renderMyOrders(token, env, chatId, userKey, null, 1);
}
