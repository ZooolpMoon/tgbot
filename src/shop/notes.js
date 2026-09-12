// ==========================================
// 🧾 订单备注（下单草稿）
//
// 用途：实物/服务类商品在下单前填地址、联系方式等，随订单交给管理员。
// 状态存在 shop_order_drafts：
//   pending = 1  表示正在等用户回复备注内容（只有这种状态才会拦截文本消息）
//   pending = 0  表示备注已保存，等待用户点「确认兑换」
// ==========================================

const MAX_NOTE_LENGTH = 300;

/** 用户点了「填写备注」：进入等待输入状态（同一商品保留原备注） */
export async function beginOrderNote(env, chatId, itemId) {
  if (!env.DB) return "";
  const current = await env.DB.prepare(
    "SELECT item_id, note FROM shop_order_drafts WHERE chat_id = ?"
  ).bind(chatId).first();

  const keep = current && Number(current.item_id) === Number(itemId) ? current.note || "" : "";

  await env.DB.prepare(`
    INSERT INTO shop_order_drafts (chat_id, item_id, note, pending, updated_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      item_id = EXCLUDED.item_id,
      note = EXCLUDED.note,
      pending = 1,
      updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, itemId, keep).run();

  return keep;
}

/** 是否正在等这个会话输入备注；是则返回 { itemId } */
export async function getPendingNoteRequest(env, chatId) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT item_id, pending FROM shop_order_drafts WHERE chat_id = ?"
  ).bind(chatId).first();
  if (!row || Number(row.pending) !== 1) return null;
  return { itemId: Number(row.item_id) };
}

/** 保存备注并结束等待状态（备注里回复 - 表示清空） */
export async function saveOrderNote(env, chatId, rawText) {
  if (!env.DB) return;
  const text = String(rawText || "").trim();
  const note = (text === "-" || text === "—") ? "" : text.slice(0, MAX_NOTE_LENGTH);
  await env.DB.prepare(
    "UPDATE shop_order_drafts SET note = ?, pending = 0, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
  ).bind(note, chatId).run();
  return note;
}

/** 读取某个商品当前保存的备注（商品不一致视为无备注） */
export async function getOrderNote(env, chatId, itemId) {
  if (!env.DB) return "";
  const row = await env.DB.prepare(
    "SELECT item_id, note FROM shop_order_drafts WHERE chat_id = ?"
  ).bind(chatId).first();
  if (!row || Number(row.item_id) !== Number(itemId)) return "";
  return row.note || "";
}

/** 下单时取走备注（无论有没有都清掉草稿） */
export async function consumeOrderNote(env, chatId, itemId) {
  const note = await getOrderNote(env, chatId, itemId);
  if (env.DB) {
    await env.DB.prepare("DELETE FROM shop_order_drafts WHERE chat_id = ?").bind(chatId).run();
  }
  return note;
}

/** 放弃填写 */
export async function cancelOrderNote(env, chatId) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM shop_order_drafts WHERE chat_id = ?").bind(chatId).run();
  }
}
