// ==========================================
// 🔘 callback_query 总入口
// ==========================================

import { answerCallback, deleteMessage, editMessageText } from "../telegram/api.js";
import { ADMIN_CALLBACK, RULES } from "../config/constants.js";

// ---- 游戏 ----
import { handleGameCallbacks } from "../games/index.js";

// ---- 用户管理 ----
import { renderUserListMenu } from "../admin/user-list.js";
import { renderUserEditMenu, handleDeleteScene } from "../admin/user-edit.js";
import { renderAdminMainMenu } from "../admin/menus.js";
import { renderAdminStats } from "../admin/stats.js";
import { renderUserPtsMenu, handleModPoints } from "../admin/user-points.js";
import { renderUserPointsLogMenu } from "../admin/user-points-log.js";
import { renderUserLimitMenu, handleModLimit } from "../admin/user-limit.js";
import { renderUserRateMenu, handleSetRate } from "../admin/user-rate.js";

// ---- 商城 ----
import {
  renderShopHome,
  renderShopItem,
  handleShopBuy,
  renderMyOrders
} from "../shop/index.js";
import {
  renderShopAdmin,
  renderShopAdminItems,
  renderShopAdminItem,
  renderShopAdminOrders,
  renderShopAdminOrder
} from "../shop/admin.js";
import {
  actionToggleItem,
  actionDeleteItem,
  actionShip,
  actionDone,
  actionCancel
} from "../shop/actions.js";

// ---- 服务 ----
import { upsertUserInfo } from "../services/users.js";
import { logError } from "../core/logger.js";

export async function handleCallback({ env, ctx, token, myId, uctx, payload }) {
  const callback = payload.callback_query;
  const fromId = uctx.userId;
  const chatId = uctx.chatId;
  const sceneKey = uctx.sceneKey;
  const userKey = uctx.userKey;
  const data = callback?.data || "";

  if (!callback?.message?.message_id) {
    if (callback?.id) {
      await answerCallback(token, callback.id, "❌ 无效的回调消息", true);
    }
    return;
  }
  const msgId = callback.message.message_id;

  if (env.DB) ctx.waitUntil(upsertUserInfo(env, uctx));

  const isGroupCtx = uctx.chatType === "group" || uctx.chatType === "supergroup";

  // ==========================================
  // 0. 商城：仅私聊可用
  // ==========================================
  if (isGroupCtx && (data.startsWith("shop_") || data.startsWith("shop_admin_"))) {
    await answerCallback(token, callback.id, "🛒 商城功能仅支持私聊使用", true);
    return;
  }

  // ==========================================
  // 1. 游戏（任何用户）
  // ==========================================
  if (data.startsWith("game_")) {
    await handleGameCallbacks(token, env, callback, chatId, userKey, msgId, fromId, data);
    return;
  }

  // ==========================================
  // 2. 商城（用户侧，任何用户）
  // ==========================================
  if (data === "shop_home") {
    await renderShopHome(token, env, chatId, userKey, msgId);
    await answerCallback(token, callback.id, "商城");
    return;
  }
  if (data.startsWith("shop_home_page_")) {
    const page = parseInt(data.replace("shop_home_page_", ""), 10) || 1;
    await renderShopHome(token, env, chatId, userKey, msgId, page);
    await answerCallback(token, callback.id, "商城");
    return;
  }
  if (data === "shop_close") {
    await deleteMessage(token, chatId, msgId);
    await answerCallback(token, callback.id, "已关闭");
    return;
  }
  if (data.startsWith("shop_view_")) {
    const itemId = parseInt(data.replace("shop_view_", ""), 10);
    await renderShopItem(token, env, chatId, userKey, msgId, itemId);
    await answerCallback(token, callback.id, "商品详情");
    return;
  }
  if (data.startsWith("shop_buy_")) {
    const itemId = parseInt(data.replace("shop_buy_", ""), 10);
    await handleShopBuy(token, env, callback, chatId, userKey, fromId, msgId, itemId, uctx.firstName);
    return;
  }
  if (data.startsWith("shop_soldout_")) {
    await answerCallback(token, callback.id, "❌ 已售罄", true);
    return;
  }
  if (data.startsWith("shop_nopts_")) {
    await answerCallback(token, callback.id, "❌ 积分不足", true);
    return;
  }
  if (data.startsWith("shop_orders_")) {
    const page = parseInt(data.replace("shop_orders_", ""), 10) || 1;
    await renderMyOrders(token, env, chatId, userKey, msgId, page);
    await answerCallback(token, callback.id, "我的订单");
    return;
  }

  // ==========================================
  // 3. 管理员权限校验
  // ==========================================
  if (!myId || fromId !== myId) {
    await answerCallback(token, callback.id, "❌ 权限不足：只有管理员可使用此菜单！", true);
    return;
  }

  // 刷新管理员会话（30 分钟）
  if (env.DB) {
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + RULES.ADMIN_SESSION_SEC;
      await env.DB.prepare(
        "INSERT INTO admin_sessions (chat_id, expires_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET expires_at = EXCLUDED.expires_at"
      ).bind(chatId, expiresAt).run();
    } catch (e) {
      logError("刷新管理员会话失败:", e);
    }
  }

  // ==========================================
  // 4. 商城（管理员侧）
  // ==========================================
  if (data === "shop_admin_home") {
    await renderShopAdmin(token, env, chatId, msgId);
    await answerCallback(token, callback.id, "商城管理");
    return;
  }
  if (data.startsWith("shop_admin_items_")) {
    const page = parseInt(data.replace("shop_admin_items_", ""), 10) || 1;
    await renderShopAdminItems(token, env, chatId, msgId, page);
    await answerCallback(token, callback.id, "商品列表");
    return;
  }
  if (data.startsWith("shop_admin_item_") && !data.startsWith("shop_admin_items_")) {
    const itemId = parseInt(data.replace("shop_admin_item_", ""), 10);
    await renderShopAdminItem(token, env, chatId, msgId, itemId);
    await answerCallback(token, callback.id, "商品详情");
    return;
  }
  if (data.startsWith("shop_admin_toggle_")) {
    const itemId = parseInt(data.replace("shop_admin_toggle_", ""), 10);
    await actionToggleItem(token, env, callback, itemId);
    await renderShopAdminItem(token, env, chatId, msgId, itemId);
    return;
  }
  if (data.startsWith("shop_admin_del_")) {
    const itemId = parseInt(data.replace("shop_admin_del_", ""), 10);
    await actionDeleteItem(token, env, callback, itemId);
    await renderShopAdminItems(token, env, chatId, msgId, 1);
    return;
  }
  if (data.startsWith("shop_admin_orders_pending_")) {
    const page = parseInt(data.replace("shop_admin_orders_pending_", ""), 10) || 1;
    await renderShopAdminOrders(token, env, chatId, msgId, "pending", page);
    await answerCallback(token, callback.id, "待处理订单");
    return;
  }
  if (data.startsWith("shop_admin_orders_all_")) {
    const page = parseInt(data.replace("shop_admin_orders_all_", ""), 10) || 1;
    await renderShopAdminOrders(token, env, chatId, msgId, "all", page);
    await answerCallback(token, callback.id, "全部订单");
    return;
  }
  if (data.startsWith("shop_admin_order_")) {
    const orderId = parseInt(data.replace("shop_admin_order_", ""), 10);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    await answerCallback(token, callback.id, "订单详情");
    return;
  }
  if (data.startsWith("shop_admin_ship_")) {
    const orderId = parseInt(data.replace("shop_admin_ship_", ""), 10);
    await actionShip(token, env, callback, orderId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }
  if (data.startsWith("shop_admin_done_")) {
    const orderId = parseInt(data.replace("shop_admin_done_", ""), 10);
    await actionDone(token, env, callback, orderId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }
  if (data.startsWith("shop_admin_cancel_")) {
    const orderId = parseInt(data.replace("shop_admin_cancel_", ""), 10);
    await actionCancel(token, env, callback, orderId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }

  // ==========================================
  // 5. 其他管理员回调
  // ==========================================
  try {
    // ---------- 用户列表 ----------
    if (data.startsWith(ADMIN_CALLBACK.USERS_PRIVATE_PREFIX)) {
      const page = parseInt(data.replace(ADMIN_CALLBACK.USERS_PRIVATE_PREFIX, ""), 10) || 1;
      await renderUserListMenu(token, env, chatId, msgId, page, "private");
      await answerCallback(token, callback.id, `已加载私聊场景第 ${page} 页`);
    }
    else if (data.startsWith(ADMIN_CALLBACK.USERS_GROUP_PREFIX)) {
      const page = parseInt(data.replace(ADMIN_CALLBACK.USERS_GROUP_PREFIX, ""), 10) || 1;
      await renderUserListMenu(token, env, chatId, msgId, page, "group");
      await answerCallback(token, callback.id, `已加载群聊场景第 ${page} 页`);
    }
    else if (data.startsWith(ADMIN_CALLBACK.GROUP_INFO_PREFIX)) {
      const gid = data.replace(ADMIN_CALLBACK.GROUP_INFO_PREFIX, "");
      await answerCallback(token, callback.id, `群 ID：${gid}\n请点击下方成员进行编辑`, true);
    }

    // ---------- 场景编辑 ----------
    else if (data.startsWith(ADMIN_CALLBACK.MANAGE_USER_PREFIX)) {
      const rowId = parseInt(data.replace(ADMIN_CALLBACK.MANAGE_USER_PREFIX, ""), 10);
      await renderUserEditMenu(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, `编辑场景 #${rowId}`);
    }

    // ---------- 积分 ----------
    else if (data.startsWith(ADMIN_CALLBACK.MENU_PTS_PREFIX)) {
      const rowId = parseInt(data.replace(ADMIN_CALLBACK.MENU_PTS_PREFIX, ""), 10);
      await renderUserPtsMenu(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, "加载积分设置");
    }
    else if (data.startsWith(ADMIN_CALLBACK.MODPTS_PREFIX)) {
      await handleModPoints({ env, token, callback, chatId, msgId, data });
    }
    else if (data.startsWith(ADMIN_CALLBACK.LOG_PTS_PREFIX)) {
      const raw = data.replace(ADMIN_CALLBACK.LOG_PTS_PREFIX, "");
      const parts = raw.split("_");
      const rowId = parseInt(parts[0], 10);
      const page = parseInt(parts[1], 10) || 1;
      await renderUserPointsLogMenu(token, env, chatId, msgId, rowId, page);
      await answerCallback(token, callback.id, "已加载积分流水");
    }

    // ---------- 每日限额 ----------
    else if (data.startsWith(ADMIN_CALLBACK.MENU_LIMIT_PREFIX)) {
      const rowId = parseInt(data.replace(ADMIN_CALLBACK.MENU_LIMIT_PREFIX, ""), 10);
      await renderUserLimitMenu(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, "加载限额设置");
    }
    else if (data.startsWith(ADMIN_CALLBACK.MODLIMIT_PREFIX)) {
      await handleModLimit({ env, token, callback, chatId, msgId, data });
    }

    // ---------- 频率 ----------
    else if (data.startsWith(ADMIN_CALLBACK.MENU_RATE_PREFIX)) {
      const rowId = parseInt(data.replace(ADMIN_CALLBACK.MENU_RATE_PREFIX, ""), 10);
      await renderUserRateMenu(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, "加载频率设置");
    }
    else if (data.startsWith(ADMIN_CALLBACK.SETRATE_PREFIX)) {
      await handleSetRate({ env, token, callback, chatId, msgId, data });
    }

    // ---------- 删除场景 ----------
    else if (data.startsWith(ADMIN_CALLBACK.DELUSER_PREFIX)) {
      await handleDeleteScene({
        env, token, callback, chatId, msgId, data,
        renderUserListMenu
      });
    }

    // ---------- 状态 ----------
    else if (data === ADMIN_CALLBACK.STATUS) {
      const statusText =
        `📊 <b>系统运行状态</b>\n-------------------------\n` +
        `👑 <b>管理员 ID:</b> <code>${myId}</code>\n` +
        `🗄️ <b>D1 数据库:</b> ${env.DB ? "✅ 已绑定" : "❌ 未绑定"}\n` +
        `🤖 <b>Workers AI:</b> ${env.AI ? "✅ 已绑定" : "❌ 未绑定"}`;
      const keyboard = { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]] };
      await editMessageText(token, chatId, msgId, statusText, keyboard, "HTML");
      await answerCallback(token, callback.id, "状态已更新");
    }

    // ---------- 统计 ----------
    else if (data === ADMIN_CALLBACK.STATS) {
      await renderAdminStats(token, env, chatId, msgId);
      await answerCallback(token, callback.id, "统计已更新");
    }

    // ---------- 主菜单 ----------
    else if (data === ADMIN_CALLBACK.MAIN_MENU) {
      // 群聊里不显示商城入口
      const showShop = !isGroupCtx;
      await renderAdminMainMenu(token, chatId, msgId, showShop);
      await answerCallback(token, callback.id, "返回主菜单");
    }

    // ---------- 清空记忆 ----------
    else if (data === ADMIN_CALLBACK.CLEAR_HISTORY) {
      if (env.DB) {
        await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey).run();
      }
      await answerCallback(token, callback.id, "🧹 对话历史已清空", true);
    }

    // ---------- 关闭 ----------
    else if (data === ADMIN_CALLBACK.CLOSE) {
      await deleteMessage(token, chatId, msgId);
      await answerCallback(token, callback.id, "菜单已关闭");
    }

    // ---------- 兜底 ----------
    else {
      await answerCallback(token, callback.id, `⚠️ 未知操作`, true);
    }
  } catch (e) {
    logError("管理员回调异常:", e);
    try {
      await answerCallback(token, callback.id, `❌ 系统异常：${e.message || e}`, true);
    } catch (_) {
      /* 忽略 */
    }
  }
}
