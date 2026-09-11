// ==========================================
// 👑 管理员菜单
// ==========================================

import { sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";

export function getAdminMainKeyboard(showShop = true) {
  const rows = [
    [
      { text: "💬 私聊用户管理", callback_data: "admin_users_private_1" },
      { text: "👥 群聊用户管理", callback_data: "admin_users_group_1" }
    ]
  ];

  if (showShop) {
    rows.push([{ text: "🛒 商城管理", callback_data: "shop_admin_home" }]);
  }

  rows.push(
    [
      { text: "📊 系统运行状态", callback_data: "admin_status" },
      { text: "📈 使用统计", callback_data: "admin_stats" }
    ],
    [{ text: "🧹 清空我的记忆", callback_data: "admin_clear_history" }],
    [{ text: "❌ 关闭菜单", callback_data: "admin_close" }]
  );

  return { inline_keyboard: rows };
}

export async function sendAdminMainMenu(token, chatId, showShop = true) {
  const text = `👑 <b>管理员控制台</b>\n-------------------------\n点击下方按钮查看或编辑用户数据：`;
  return sendMessageWithKeyboard(token, chatId, text, getAdminMainKeyboard(showShop), "HTML");
}

export async function renderAdminMainMenu(token, chatId, messageId, showShop = true) {
  const text = `👑 <b>管理员控制台</b>\n-------------------------\n点击下方按钮查看或编辑用户数据：`;
  return editMessageText(token, chatId, messageId, text, getAdminMainKeyboard(showShop), "HTML");
}