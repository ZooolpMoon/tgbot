// ==========================================
// 🧭 引导式输入会话
//
// 管理员/用户点开一个引导流程后，后续的纯文本会被该流程消费。
// 如果同一个会话里残留了两个以上的流程状态，message.js 里靠前的那个
// 会把消息全部吃掉——现象是「点了按钮，接下来的输入却没有任何反应」。
// 因此：**开始任何新流程前，先清掉同会话里的其它流程状态**。
//
// 各流程的 30 分钟有效期与定时清理仍在各自模块 / services/daily.js 里，
// 这里只负责「互斥」。
// ==========================================

/**
 * 会拦截文本消息的引导会话表（按 chat_id 一行）。
 * shop_order_drafts 不在这里：它是「下单备注」，清掉会丢用户已经写好的备注，
 * 单独用 pending=0 让它不再拦截消息。
 */
export const GUIDE_SESSION_TABLES = [
  "shop_add_sessions",
  "shop_edit_sessions",
  "kb_sessions",
  "guard_sessions",
  "admin_manage_sessions",
  "group_tag_sessions"
];

/**
 * 开新引导流程前清掉其它流程状态，避免互相抢消息。
 * @param {object} env
 * @param {string} chatId 会话 ID（私聊用用户 ID，群里用群 ID）
 */
export async function clearGuideSessions(env, chatId) {
  if (!env?.DB || !chatId) return;
  const statements = GUIDE_SESSION_TABLES.map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId)
  );
  // 备注流程只解除「正在等回复」，保留已填内容
  statements.push(
    env.DB.prepare("UPDATE shop_order_drafts SET pending = 0, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
      .bind(chatId)
  );
  await env.DB.batch(statements);
}
