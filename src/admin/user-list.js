// ==========================================
// 👥 用户列表
// ==========================================

import { editMessageText, sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";

export async function renderUserListMenu(token, env, chatId, messageId, page = 1, listType = "private") {
  if (!env.DB) {
    const t = "❌ 未绑定 D1 数据库。";
    return messageId ? editMessageText(token, chatId, messageId, t) : sendMessage(token, chatId, t);
  }

  const pageSize = 5;
  const offset = (page - 1) * pageSize;
  const isPrivate = listType === "private";
  const where = isPrivate ? "WHERE s.chat_type = 'private'" : "WHERE s.chat_type IN ('group','supergroup')";

  const countRes = await env.DB.prepare(`SELECT COUNT(*) as total FROM user_scenes s ${where}`).first();
  const total = countRes ? countRes.total : 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const { results } = await env.DB.prepare(`
    SELECT s.id, s.scene_key, s.user_key, s.user_id, s.chat_id, s.chat_type,
           s.username, s.first_name, s.lang,
           COALESCE(u.points, 0) AS points
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    ${where}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(pageSize, offset).all();

  const title = isPrivate ? "💬 <b>私聊场景列表</b>" : "👥 <b>群聊场景列表</b>";
  let text = `${title}（共 ${total} 个）\n页码：<b>${page} / ${totalPages}</b>\n-------------------------\n`;
  text += `💡 每个场景独立配置，但积分是全局共享的。\n\n`;

  const inline_keyboard = [];

  if (results && results.length > 0) {
    if (isPrivate) {
      results.forEach(u => {
        const name = u.first_name || u.user_id;
        const tag = u.username ? ` (${u.username})` : "";
        const pts = Number.isFinite(Number(u.points)) ? Number(u.points) : 0;
        inline_keyboard.push([{
          text: `#${u.id} 👤 ${name}${tag} | 🪙 ${pts}`,
          callback_data: `admin_manage_user_${u.id}`
        }]);
      });
    } else {
      const groups = new Map();
      results.forEach(u => {
        const gid = String(u.chat_id || "unknown");
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid).push(u);
      });
      for (const [gid, members] of groups) {
        inline_keyboard.push([{ text: `🏠 群 ${gid}（${members.length} 个场景）`, callback_data: `admin_group_info_${gid}` }]);
        members.forEach(u => {
          const name = u.first_name || u.user_id;
          const tag = u.username ? ` (${u.username})` : "";
          const pts = Number.isFinite(Number(u.points)) ? Number(u.points) : 0;
          inline_keyboard.push([{
            text: `  ↳ #${u.id} ${name}${tag} | 🪙 ${pts}`,
            callback_data: `admin_manage_user_${u.id}`
          }]);
        });
      }
    }
  } else {
    text += `\n<i>(当前没有${isPrivate ? "私聊" : "群聊"}场景记录)</i>\n`;
  }

  const pagePrefix = isPrivate ? "admin_users_private_" : "admin_users_group_";
  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `${pagePrefix}${page - 1}` });
  if (page < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `${pagePrefix}${page + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]);

  const keyboard = { inline_keyboard };
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}