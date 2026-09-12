// ==========================================
// 🛒 商城 - 管理员引导式添加商品
//
// 6 步引导：名称 → 价格 → 库存 → 分类 → 说明 → 图标。
// 会话存在 shop_add_sessions，30 分钟不操作自动失效。
// ==========================================

import { sendMessage } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { logAdminAction } from "../services/admin-log.js";
import { clearGuideSessions } from "../services/sessions.js";
import { CATEGORY_MAP, categoryText, parseCategory } from "./categories.js";

/** 各字段的输入上限，防止一条超长消息把商品记录撑爆 */
const LIMITS = {
  NAME: 60,
  DESCRIPTION: 500,
  ICON: 8
};

const SESSION_TTL_MINUTES = 30;

// 兼容旧引用：分类映射已挪到 categories.js
export { CATEGORY_MAP };

/** 开始「添加商品」引导：重置草稿并询问商品名称 */
export async function startAddItem(token, env, chatId) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  // 开新流程前先清掉其它引导会话（否则残留的会话会抢走接下来的文本）
  await clearGuideSessions(env, chatId);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO shop_add_sessions (chat_id, step, name, price, stock, category, icon, description, updated_at)
      VALUES (?, 1, '', 0, -1, 'virtual', '', '', CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        step = 1,
        name = '',
        price = 0,
        stock = -1,
        category = 'virtual',
        icon = '',
        description = '',
        updated_at = CURRENT_TIMESTAMP
    `).bind(chatId)
  ]);

  return sendMessage(
    token,
    chatId,
    "➕ <b>添加商品</b>\n-------------------------\n请输入<b>商品名称</b>：\n（回复 /shop_add cancel 可取消）",
    "HTML"
  );
}

/** 取消添加商品流程 */
export async function cancelAddItem(token, env, chatId) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");
  await env.DB.prepare("DELETE FROM shop_add_sessions WHERE chat_id = ?").bind(chatId).run();
  return sendMessage(token, chatId, "🚫 已取消添加商品。");
}

/** 处理添加流程里的文本输入；返回 true 表示这条消息已被消费 */
export async function handleAddItemInput({ env, token, chatId, userText, adminId = null }) {
  if (!env.DB) return false;

  const session = await env.DB.prepare(
    `SELECT * FROM shop_add_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
  if (!session) return false;

  const step = Number(session.step) || 1;
  const text = String(userText || "").trim();
  if (!text) return true;

  // 第 1 步：名称
  if (step === 1) {
    await env.DB.prepare(
      "UPDATE shop_add_sessions SET name = ?, step = 2, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(text.slice(0, LIMITS.NAME), chatId).run();
    await sendMessage(
      token,
      chatId,
      "✅ 名称已记录。\n请输入<b>商品价格</b>（整数积分，例如 100）：",
      "HTML"
    );
    return true;
  }

  // 第 2 步：价格
  if (step === 2) {
    const price = Number.parseInt(text, 10);
    if (!Number.isInteger(price) || price < 0) {
      await sendMessage(token, chatId, "⚠️ 价格必须是大于等于 0 的整数，请重新输入：");
      return true;
    }
    await env.DB.prepare(
      "UPDATE shop_add_sessions SET price = ?, step = 3, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(price, chatId).run();
    await sendMessage(
      token,
      chatId,
      "✅ 价格已记录。\n请输入<b>库存数量</b>（整数；-1 表示不限库存）：",
      "HTML"
    );
    return true;
  }

  // 第 3 步：库存
  if (step === 3) {
    const stock = Number.parseInt(text, 10);
    if (!Number.isInteger(stock) || stock < -1) {
      await sendMessage(token, chatId, "⚠️ 库存必须是大于等于 0 的整数，或 -1 表示不限库存，请重新输入：");
      return true;
    }
    await env.DB.prepare(
      "UPDATE shop_add_sessions SET stock = ?, step = 4, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(stock, chatId).run();
    await sendMessage(
      token,
      chatId,
      "✅ 库存已记录。\n请选择<b>分类</b>：\n1 虚拟物品（卡密、兑换码、道具…）\n2 服务（代做、咨询、定制…）\n（直接回复 1/2 或分类名）",
      "HTML"
    );
    return true;
  }

  // 第 4 步：分类
  if (step === 4) {
    const category = parseCategory(text);
    if (!category) {
      await sendMessage(token, chatId, "⚠️ 分类无效，请回复：1 虚拟物品 / 2 服务");
      return true;
    }
    await env.DB.prepare(
      "UPDATE shop_add_sessions SET category = ?, step = 5, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(category, chatId).run();
    await sendMessage(
      token,
      chatId,
      "✅ 分类已记录。\n请输入<b>商品说明</b>（回复 - 表示不填）：",
      "HTML"
    );
    return true;
  }

  // 第 5 步：说明
  if (step === 5) {
    const description = text === "-" ? "" : text.slice(0, LIMITS.DESCRIPTION);
    await env.DB.prepare(
      "UPDATE shop_add_sessions SET description = ?, step = 6, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(description, chatId).run();
    await sendMessage(
      token,
      chatId,
      "✅ 说明已记录。\n请输入一个<b>emoji 图标</b>（回复 - 使用默认 🛍️）：",
      "HTML"
    );
    return true;
  }

  // 第 6 步：图标并保存
  const icon = text === "-" ? "🛍️" : text.slice(0, LIMITS.ICON);
  await env.DB.prepare(
    "UPDATE shop_add_sessions SET icon = ?, step = 7, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
  ).bind(icon, chatId).run();

  const s = await env.DB.prepare(
    "SELECT * FROM shop_add_sessions WHERE chat_id = ?"
  ).bind(chatId).first();

  await env.DB.prepare(`
    INSERT INTO shop_items (name, description, icon, price, stock, category, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(s.name, s.description, s.icon, s.price, s.stock, s.category).run();

  await env.DB.prepare("DELETE FROM shop_add_sessions WHERE chat_id = ?").bind(chatId).run();

  await logAdminAction(env, {
    adminId, chatId, action: "shop_item_add",
    detail: `${s.icon} ${s.name} 价格 ${s.price} 库存 ${s.stock}`
  });

  const catText = categoryText(s.category);
  await sendMessage(
    token,
    chatId,
    `🎉 <b>商品添加成功！</b>\n-------------------------\n${escapeHtml(s.icon)} <b>${escapeHtml(s.name)}</b>\n💰 价格：${s.price}\n📦 库存：${s.stock === -1 ? "不限" : s.stock}\n📂 分类：${catText}\n📝 说明：${escapeHtml(s.description) || "（无）"}`,
    "HTML"
  );
  return true;
}
