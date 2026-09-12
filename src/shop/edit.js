// ==========================================
// 🛒 商城 - 管理员引导式编辑商品
// 入口：/shop_edit <商品ID>  或  商品详情 → ✏️ 编辑
//
// 会话存在 shop_edit_sessions，30 分钟不操作自动失效，
// 避免管理员中途离开后，普通私聊消息被当成「新字段值」吞掉。
// ==========================================

import {
  sendMessage,
  sendMessageWithKeyboard,
  editMessageText,
  answerCallback
} from "../telegram/api.js";
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { escapeHtml } from "../utils/html.js";
import { grid } from "../utils/layout.js";
import { SHOP_EDIT_FIELDS } from "../config/constants.js";
import { logAdminAction } from "../services/admin-log.js";
import { clearGuideSessions } from "../services/sessions.js";
import { CATEGORY_MAP, CATEGORY_TEXT, categoryText, parseCategory } from "./categories.js";

const SESSION_TTL_MINUTES = 30;

/**
 * 商品字段编辑键盘（两列网格）。
 * 面板与指令入口共用同一份定义，避免两处按钮不一致（以前 /shop_edit 就少了「限购」）。
 */
export function buildItemEditKeyboard(itemId) {
  const field = (key, text) => ({
    text,
    callback_data: `shop_admin_editf_${itemId}_${key}`
  });
  return {
    inline_keyboard: [
      ...grid([
        field("name", "📛 改名称"),
        field("price", "💰 改价格"),
        field("stock", "📦 改库存"),
        field("limit", "🙋 改限购"),
        field("category", "📂 改分类"),
        field("icon", "🎨 改图标")
      ]),
      [field("description", "📝 改说明")],
      [{ text: "🔙 返回商品详情", callback_data: `shop_admin_item_${itemId}` }]
    ]
  };
}

// ---------- 字段编辑面板 ----------
export async function renderItemEditMenu(token, env, chatId, messageId, itemId) {
  if (!env.DB) return;

  const item = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  if (!item) {
    return editMessageText(token, chatId, messageId, "❌ 商品不存在",
      { inline_keyboard: [[{ text: "🔙 返回商品列表", callback_data: "shop_admin_items_1" }]] });
  }

  const stockText = Number(item.stock) === -1 ? "不限" : item.stock;
  const limitText = Number(item.per_user_limit) > 0 ? `每人 ${item.per_user_limit} 件` : "不限";
  const text =
    `✏️ <b>编辑商品 #${item.id}</b>\n` +
    `-------------------------\n` +
    `${item.icon} <b>${escapeHtml(item.name)}</b>\n` +
    `💰 价格：🪙 ${item.price}\n` +
    `📦 库存：${stockText}\n` +
    `🙋 限购：${limitText}\n` +
    `📂 分类：${categoryText(item.category)}\n` +
    `🔘 状态：${item.enabled ? "✅ 已上架" : "🚫 已下架"}\n` +
    `📝 说明：${escapeHtml(item.description) || "（无）"}\n\n` +
    `请选择要修改的字段，机器人会一步步引导你输入新值：`;

  return editMessageText(token, chatId, messageId, text, buildItemEditKeyboard(item.id), "HTML");
}

// ---------- 为某个字段开启输入会话 ----------
/** 记录「正在编辑哪个商品的哪个字段」，然后提示管理员输入新值 */
export async function startEditField({ env, token, chatId, itemId, field }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");
  if (!SHOP_EDIT_FIELDS[field]) return sendMessage(token, chatId, "⚠️ 不支持的字段。");

  const item = await env.DB.prepare(
    "SELECT id, name, price, stock, category, icon, description, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();
  if (!item) return sendMessage(token, chatId, `❌ 商品 #${itemId} 不存在。`);

  // 开新流程前先清掉其它引导会话（含「添加商品」），避免互相抢消息
  await clearGuideSessions(env, chatId);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO shop_edit_sessions (chat_id, item_id, field, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        item_id = EXCLUDED.item_id,
        field = EXCLUDED.field,
        updated_at = CURRENT_TIMESTAMP
    `).bind(chatId, item.id, field)
  ]);

  return sendMessage(token, chatId, editPrompt(item, field), "HTML");
}

/** 按字段生成对应的输入提示 */
function editPrompt(item, field) {
  const head = `✏️ <b>编辑商品 #${item.id}</b> · ${SHOP_EDIT_FIELDS[field]}\n-------------------------\n`;
  const cancelTip = `\n\n（回复 <code>/shop_edit cancel</code> 取消编辑）`;

  switch (field) {
    case "name":
      return head + `当前名称：<b>${escapeHtml(item.name)}</b>\n\n请输入<b>新的商品名称</b>：` + cancelTip;
    case "price":
      return head + `当前价格：<b>🪙 ${item.price}</b>\n\n请输入<b>新的价格</b>（整数积分，≥ 0）：` + cancelTip;
    case "stock":
      return head + `当前库存：<b>${Number(item.stock) === -1 ? "不限" : item.stock}</b>\n\n请输入<b>新的库存</b>（整数；-1 表示不限库存）：` + cancelTip;
    case "category":
      return head + `当前分类：<b>${categoryText(item.category)}</b>\n\n请选择<b>新分类</b>：\n1 虚拟物品\n2 服务\n\n（直接回复 1/2 或分类名）` + cancelTip;
    case "icon":
      return head + `当前图标：<b>${escapeHtml(item.icon) || "无"}</b>\n\n请输入<b>新的 emoji 图标</b>：` + cancelTip;
    case "description":
      return head + `当前说明：${escapeHtml(item.description) || "（无）"}\n\n请输入<b>新的商品说明</b>（回复 - 表示清空）：` + cancelTip;
    case "limit":
      return head + `当前限购：<b>${Number(item.per_user_limit) > 0 ? `每人 ${item.per_user_limit} 件` : "不限"}</b>\n\n请输入<b>每人限购数量</b>（整数；0 表示不限）：` + cancelTip;
    default:
      return head + "请输入新值：" + cancelTip;
  }
}

// ---------- 取消编辑 ----------
export async function cancelEditItem(token, env, chatId) {
  if (env.DB) {
    await env.DB.prepare("DELETE FROM shop_edit_sessions WHERE chat_id = ?").bind(chatId).run();
  }
  return sendMessage(token, chatId, "🚫 已取消编辑商品。");
}

// ---------- 文本输入 → 落库 ----------
/** 处理编辑流程里的文本输入；返回 true 表示这条消息已被消费 */
export async function handleEditItemInput({ env, token, chatId, userText, adminId = null }) {
  if (!env.DB) return false;

  const session = await env.DB.prepare(
    `SELECT * FROM shop_edit_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  const field = session.field;
  const itemId = Number(session.item_id);

  const item = await env.DB.prepare(
    "SELECT id, name, price, stock, category, icon, description, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();
  if (!item) {
    await env.DB.prepare("DELETE FROM shop_edit_sessions WHERE chat_id = ?").bind(chatId).run();
    await sendMessage(token, chatId, `❌ 商品 #${itemId} 已不存在，编辑会话已结束。`);
    return true;
  }

  let value;
  let validationError = null;

  switch (field) {
    case "name":
      value = text.slice(0, 60);
      break;
    case "price": {
      const price = Number.parseInt(text, 10);
      if (!Number.isInteger(price) || price < 0) validationError = "⚠️ 价格必须是大于等于 0 的整数，请重新输入：";
      else value = price;
      break;
    }
    case "stock": {
      const stock = Number.parseInt(text, 10);
      if (!Number.isInteger(stock) || stock < -1) validationError = "⚠️ 库存必须是大于等于 0 的整数，或 -1 表示不限库存，请重新输入：";
      else value = stock;
      break;
    }
    case "category": {
      const category = parseCategory(text);
      if (!category) validationError = "⚠️ 分类无效，请回复：1 虚拟物品 / 2 服务";
      else value = category;
      break;
    }
    case "icon":
      value = text.slice(0, 8);
      break;
    case "description":
      value = text === "-" ? "" : text.slice(0, 500);
      break;
    case "limit": {
      const limit = Number.parseInt(text, 10);
      if (!Number.isInteger(limit) || limit < 0) validationError = "⚠️ 限购数量必须是大于等于 0 的整数（0 = 不限），请重新输入：";
      else value = limit;
      break;
    }
    default:
      validationError = "⚠️ 无法识别的字段，请重新从商品编辑面板进入。";
  }

  if (validationError) {
    await sendMessage(token, chatId, validationError);
    return true;
  }

  // 字段名 → 数据库列名（白名单，避免拼接注入）
  const COLUMN_MAP = {
    name: "name", price: "price", stock: "stock", category: "category",
    icon: "icon", description: "description", limit: "per_user_limit"
  };
  const column = COLUMN_MAP[field];

  await env.DB.prepare(
    `UPDATE shop_items SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(value, itemId).run();

  await env.DB.prepare("DELETE FROM shop_edit_sessions WHERE chat_id = ?").bind(chatId).run();

  const after = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  const stockText = Number(after.stock) === -1 ? "不限" : after.stock;
  const limitText = Number(after.per_user_limit) > 0 ? `每人 ${after.per_user_limit} 件` : "不限";
  const text2 =
    `✅ <b>修改成功</b>\n` +
    `-------------------------\n` +
    `${after.icon} <b>${escapeHtml(after.name)}</b>（#${after.id}）\n` +
    `💰 价格：🪙 ${after.price}\n` +
    `📦 库存：${stockText}\n` +
    `🙋 限购：${limitText}\n` +
    `📂 分类：${categoryText(after.category)}\n` +
    `🔘 状态：${after.enabled ? "✅ 已上架" : "🚫 已下架"}\n` +
    `📝 说明：${escapeHtml(after.description) || "（无）"}\n\n` +
    `继续修改请发送 <code>/shop_edit ${after.id}</code>。`;

  await sendMessage(token, chatId, text2, "HTML");

  await logAdminAction(env, {
    adminId, chatId,
    action: "shop_item_edit",
    detail: `#${itemId} ${SHOP_EDIT_FIELDS[field] || field} → ${String(value).slice(0, 80)}`
  });

  return true;
}

// ---------- /shop_edit 指令 ----------
/** /shop_edit <商品ID>：直接打开某个商品的字段编辑菜单；带 cancel 则结束会话 */
export async function cmdShopEdit({ env, ctx, token, chatId, isMaster, isGroupCtx, rawText, myId }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }
  if (isGroupCtx) {
    await sendAutoDelete(token, chatId, "🛒 商品编辑仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
    return;
  }

  const arg = String(rawText || "").replace(/^\/shop_edit(@\w+)?/i, "").trim();

  if (/^(cancel|取消)$/i.test(arg)) {
    await cancelEditItem(token, env, chatId);
    return;
  }

  const itemId = Number.parseInt(arg, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    await sendMessageWithKeyboard(
      token, chatId,
      "✏️ <b>编辑商品</b>\n-------------------------\n" +
      "用法：<code>/shop_edit 商品ID</code>\n" +
      "例如：<code>/shop_edit 3</code>\n\n" +
      "也可以从 <b>商城管理 → 商品列表</b> 点击商品进入详情后选择「✏️ 编辑」。",
      { inline_keyboard: [[{ text: "📦 打开商品列表", callback_data: "shop_admin_items_1" }]] },
      "HTML"
    );
    return;
  }

  const item = await env.DB.prepare("SELECT id, name FROM shop_items WHERE id = ?").bind(itemId).first();
  if (!item) {
    await sendMessage(token, chatId, `❌ 商品 #${itemId} 不存在。`);
    return;
  }

  await sendMessageWithKeyboard(
    token, chatId,
    `✏️ <b>编辑商品 #${item.id}</b>\n-------------------------\n${escapeHtml(item.name)}\n\n请选择要修改的字段：`,
    buildItemEditKeyboard(item.id),
    "HTML"
  );
}
