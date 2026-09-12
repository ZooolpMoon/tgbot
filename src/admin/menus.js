// ==========================================
// 👑 管理员菜单
// 排版约定：两列网格，避免菜单被拉成一条长龙
// ==========================================

import { sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";

/**
 * 管理员主菜单键盘。
 * @param {boolean} showShop 群聊里不显示商城入口（商城仅私聊可用）
 */
export function getAdminMainKeyboard(showShop = true) {
  const buttons = [
    // 用户管理是一级入口，点进去再选「私聊用户 / 群组用户」
    { text: "👥 用户管理", callback_data: ADMIN_CALLBACK.USERS_HOME },
    { text: "📚 知识库", callback_data: ADMIN_CALLBACK.KB_HOME },
    { text: "📜 群规执法", callback_data: ADMIN_CALLBACK.GUARD_HOME }
  ];

  if (showShop) {
    buttons.push({ text: "🛒 商城管理", callback_data: "shop_admin_home" });
  }

  buttons.push(
    { text: "🎟️ 兑换码", callback_data: "admin_codes_1" },
    { text: "⚙️ 功能开关", callback_data: "admin_feat_home" },
    { text: "🗑️ 自动删除", callback_data: ADMIN_CALLBACK.AUTO_DELETE_HOME },
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
  `用户管理 · 商城与兑换码 · 功能开关 · 自动删除 · 日志统计`;

/** 二级菜单：用户管理（私聊用户 / 群组用户） */
export function getUserManageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💬 私聊用户", callback_data: `${ADMIN_CALLBACK.USERS_PRIVATE_PREFIX}1` },
        { text: "👥 群组用户", callback_data: `${ADMIN_CALLBACK.USERS_GROUP_PREFIX}1` }
      ],
      [
        { text: "🚫 封禁名单", callback_data: `${ADMIN_CALLBACK.BANNED_PREFIX}1` },
        { text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }
      ]
    ]
  };
}

const USER_MENU_TEXT =
  `👥 <b>用户管理</b>\n` +
  `${LAYOUT.DIVIDER}\n` +
  `💬 <b>私聊用户</b> —— 每个私聊用户一个场景，可改积分、限额、频率、功能开关\n` +
  `👥 <b>群组用户</b> —— 先选群，再看群成员（同一用户在不同群互不影响）\n` +
  `🚫 <b>封禁名单</b> —— 查看被封禁用户并一键解封（添加封禁用 <code>/ban &lt;用户ID&gt;</code>）\n\n` +
  `积分是<b>全局共享</b>的，其余配置都是<b>场景独立</b>的。`;

/** 新发一条管理员主菜单（/admin 指令用） */
export async function sendAdminMainMenu(token, chatId, showShop = true) {
  return sendMessageWithKeyboard(token, chatId, MENU_TEXT, getAdminMainKeyboard(showShop), "HTML");
}

/** 原地刷新管理员主菜单（按钮回调用） */
export async function renderAdminMainMenu(token, chatId, messageId, showShop = true) {
  return editMessageText(token, chatId, messageId, MENU_TEXT, getAdminMainKeyboard(showShop), "HTML");
}

/** 原地刷新「用户管理」二级菜单 */
export async function renderUserManageMenu(token, chatId, messageId) {
  return editMessageText(token, chatId, messageId, USER_MENU_TEXT, getUserManageKeyboard(), "HTML");
}

/** 新发一条「用户管理」二级菜单（指令入口用） */
export async function sendUserManageMenu(token, chatId) {
  return sendMessageWithKeyboard(token, chatId, USER_MENU_TEXT, getUserManageKeyboard(), "HTML");
}
