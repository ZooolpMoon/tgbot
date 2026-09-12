// ==========================================
// 👑 管理员菜单
// 排版约定：两列网格，避免菜单被拉成一条长龙
// ==========================================

import { sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { grid } from "../utils/layout.js";

/**
 * 管理员主菜单键盘。
 * @param {boolean} showShop 群聊里不显示商城入口（商城仅私聊可用）
 */
export function getAdminMainKeyboard(showShop = true) {
  const buttons = [
    { text: "💬 私聊用户", callback_data: "admin_users_private_1" },
    { text: "👥 群聊用户", callback_data: "admin_users_group_1" }
  ];

  if (showShop) {
    buttons.push({ text: "🛒 商城管理", callback_data: "shop_admin_home" });
  }

  buttons.push(
    { text: "🎟️ 兑换码", callback_data: "admin_codes_1" },
    { text: "✅ 每日任务", callback_data: "admin_tasks" },
    { text: "⚙️ 功能开关", callback_data: "admin_feat_home" },
    { text: "📋 操作日志", callback_data: "admin_logs_1" },
    { text: "📊 运行状态", callback_data: "admin_status" },
    { text: "📈 使用统计", callback_data: "admin_stats" },
    { text: "🧹 清空我的记忆", callback_data: "admin_clear_history" }
  );

  const rows = grid(buttons);
  rows.push([{ text: "❌ 关闭菜单", callback_data: "admin_close" }]);

  return { inline_keyboard: rows };
}

const MENU_TEXT =
  `👑 <b>管理员控制台</b>\n` +
  `-------------------------\n` +
  `用户管理 · 商城与兑换码 · 每日任务 · 功能开关 · 日志统计`;

/** 新发一条管理员主菜单（/admin 指令用） */
export async function sendAdminMainMenu(token, chatId, showShop = true) {
  return sendMessageWithKeyboard(token, chatId, MENU_TEXT, getAdminMainKeyboard(showShop), "HTML");
}

/** 原地刷新管理员主菜单（按钮回调用） */
export async function renderAdminMainMenu(token, chatId, messageId, showShop = true) {
  return editMessageText(token, chatId, messageId, MENU_TEXT, getAdminMainKeyboard(showShop), "HTML");
}
