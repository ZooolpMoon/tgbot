// ==========================================
// 🔘 callback_query 总入口
//
// 路由顺序很重要（都用 startsWith 判断前缀）：
//   0. 群聊里屏蔽商城（商城仅私聊）
//   0.5 封禁校验（管理员不受限）
//   1. 游戏 → 2. 商城用户侧 → 2.5 积分/排行榜
//   3. 管理员权限校验 → 4. 商城管理端 → 4.5 群发 → 5. 其他管理功能
// 前缀更长的分支必须排在更短的前面，否则会被提前截胡。
// ==========================================

import { answerCallback, deleteMessage, editMessageText, sendMessage } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { ADMIN_CALLBACK, RULES } from "../config/constants.js";

// ---- 游戏 ----
import { handleGameCallbacks } from "../games/index.js";

// ---- 用户管理 ----
import { renderUserListMenu } from "../admin/user-list.js";
import { renderGroupListMenu, renderGroupMembersMenu } from "../admin/user-groups.js";
import { renderBannedListMenu, handleUnban } from "../admin/user-banned.js";
import {
  renderKnowledgeHome, renderDocumentList, renderDocumentDetail,
  startAddDocument, startKnowledgeTest, handleDocumentToggle,
  handleDocumentDelete, handleDocumentDeleteConfirm,
  handleKnowledgeReindex, handleDocPromote, handleDocCopy
} from "../admin/knowledge.js";
import {
  renderUserEditMenu,
  handleDeleteScene,
  confirmDeleteScene,
  handleToggleBlock,
  handleClearSceneMemory
} from "../admin/user-edit.js";
import { renderAdminMainMenu, renderUserManageMenu } from "../admin/menus.js";
import { renderAdminStats } from "../admin/stats.js";
import { renderAdminLogs } from "../admin/logs.js";
import { renderUserDetail } from "../admin/user-detail.js";
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
  actionDone,
  actionCancel,
  actionRefund,
  handleUserCancelOrder,
  handleUserRefundOrder
} from "../shop/actions.js";
import { renderBag, handleUseBagItem } from "../shop/bag.js";
import { startAddItem } from "../shop/add.js";
import { renderItemEditMenu, startEditField } from "../shop/edit.js";
import { renderPointsLog } from "./commands/points.js";
import { renderRank, closeRank } from "./commands/rank.js";
import { startBroadcast, cancelBroadcast } from "./commands/broadcast.js";
import { renderCodeList, handleCodeToggle } from "./commands/codes.js";
import {
  renderFeatureHome, renderFeatureScope, handleFeatureToggle, handleFeatureReset
} from "../admin/features.js";
import { handleAutoDeleteCallback } from "../admin/auto-delete.js";
import { beginOrderNote } from "../shop/notes.js";
import {
  getTagSession, handleTagCancel, handleTagGroupPick, handleTagOrderEntry, renderTagGroupPicker
} from "../shop/tags.js";

// ---- 服务 ----
import { upsertUserInfo, isUserBlocked } from "../services/users.js";
import { isFeatureEnabled } from "../services/features.js";
import { logError } from "../core/logger.js";
import { handleGuardCallback } from "../admin/guard.js";
import { handleAppealCallback } from "../admin/guard.js";
import { handleGuardPanelCallback } from "../admin/guard-panel.js";
import { handleWelcomeCallback } from "../admin/welcome-panel.js";
import { handleJoinVerifyCallback } from "../services/welcome.js";
import { handleAdminsCallback } from "../admin/admins.js";
import { CAPABILITIES, can, getAdminRole, isBackstageRole } from "../services/admins.js";

/**
 * 回调前缀 → 需要的能力（v3.0.0 起的角色权限）。
 * 顺序敏感：更长的前缀必须排在更短的前面（例如 admin_admins_dok_ 在 admin_admins_d_ 之前）。
 * 返回 null 表示「任何已授权角色都能用」。
 */
const CALLBACK_CAPABILITIES = [
  ["admin_admins", "manage_admins"],
  ["admin_users", "manage_users"],
  ["admin_groups_", "manage_users"],
  ["admin_group_m_", "manage_users"],
  ["admin_manage_user_", "manage_users"],
  ["admin_detail_", "manage_users"],
  ["admin_menu_pts_", "manage_users"],
  ["admin_modpts_", "manage_users"],
  ["admin_log_pts_", "manage_users"],
  ["admin_menu_limit_", "manage_users"],
  ["admin_modlimit_", "manage_users"],
  ["admin_menu_rate_", "manage_users"],
  ["admin_setrate_", "manage_users"],
  ["admin_block_", "manage_users"],
  ["admin_clearmem_", "manage_users"],
  ["admin_deluser_confirm_", "manage_users"],
  ["admin_deluser_do_", "manage_users"],
  ["admin_banned_", "manage_users"],
  ["admin_unban_", "manage_users"],
  ["shop_admin_", "manage_shop"],
  ["admin_kb", "manage_kb"],
  ["admin_guard", "manage_guard"],
  ["admin_welcome", "manage_guard"],
  ["admin_feat", "manage_features"],
  ["admin_autodel", "manage_autodelete"],
  ["admin_codes_", "manage_codes"],
  ["admin_code_toggle_", "manage_codes"],
  ["admin_logs", "view_logs"],
  ["admin_stats", "view_stats"],
  ["admin_status", "view_stats"],
  ["admin_broadcast_", "broadcast"]
];

/** 某个回调数据需要的能力（null = 任何已授权角色） */
export function capabilityForCallback(data) {
  const raw = String(data || "");
  for (const [prefix, capability] of CALLBACK_CAPABILITIES) {
    if (raw.startsWith(prefix)) return capability;
  }
  return null;
}

/**
 * 处理按钮回调（callback_query）。
 * 各分支都会负责应答复按钮，避免用户在客户端看到一直转圈。
 */
export async function handleCallback({ env, ctx, token, myId, uctx, payload }) {
  const callback = payload.callback_query;
  const fromId = uctx.userId;
  const chatId = uctx.chatId;
  const sceneKey = uctx.sceneKey;
  const userKey = uctx.userKey;
  const data = callback?.data || "";
  /** 当前用户角色（2.8 之前解析一次，供执法卡片与后台校验共用） */
  let role = null;

  if (!callback?.message?.message_id) {
    if (callback?.id) {
      await answerCallback(token, callback.id, "❌ 无效的回调消息", true);
    }
    return;
  }
  const msgId = callback.message.message_id;

  // 后台更新用户资料，不阻塞回调响应（ctx 可能为空，加保护）
  if (env.DB && ctx?.waitUntil) ctx.waitUntil(upsertUserInfo(env, uctx));

  const isGroupCtx = uctx.chatType === "group" || uctx.chatType === "supergroup";

  // ==========================================
  // 0. 商城：仅私聊可用
  // ==========================================
  // shop_admin_ 本身就以 shop_ 开头，这里用一次前缀判断即可
  if (isGroupCtx && data.startsWith("shop_")) {
    await answerCallback(token, callback.id, "🛒 商城功能仅支持私聊使用", true);
    return;
  }

  // ==========================================
  // 0.5 封禁校验（机器人管理员不受限，与 message.js 保持一致）
  // ==========================================
  if (myId && fromId !== myId && env.DB) {
    try {
      if (await isUserBlocked(env, userKey)) {
        // 机器人管理员豁免封禁：正常途径封不了他们（banUserById / setUserBlocked 会拒绝），
        // 这里兜住「先被封、后授权」的历史数据，否则他连 /unban 都发不出去。
        // **只在真被封时**才多查一次角色 —— 普通用户的按钮路径不受影响。
        const blockedRole = await getAdminRole(env, fromId, { ownerId: myId });
        if (!blockedRole) {
          await answerCallback(token, callback.id, "🚫 你已被管理员限制使用本机器人", true);
          return;
        }
      }
    } catch (e) {
      logError("封禁状态校验失败:", e);
    }
  }

  // ==========================================
  // 1. 游戏（任何用户）
  // ==========================================
  if (data.startsWith("game_")) {
    if (!(await isFeatureEnabled(env, sceneKey, "game"))) {
      await answerCallback(token, callback.id, "⚠️ 本场景已关闭「游戏大厅」", true);
      return;
    }
    await handleGameCallbacks(token, env, callback, chatId, userKey, msgId, fromId, data, sceneKey);
    return;
  }

  // ==========================================
  // 2. 商城（用户侧，任何用户）
  // ==========================================
  if (data.startsWith("shop_") && !(await isFeatureEnabled(env, sceneKey, "shop"))) {
    await answerCallback(token, callback.id, "⚠️ 本场景已关闭「积分商城」", true);
    return;
  }
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
  // 填写下单备注
  if (data.startsWith("shop_note_")) {
    const itemId = parseInt(data.replace("shop_note_", ""), 10);
    if (!Number.isInteger(itemId)) {
      await answerCallback(token, callback.id, "⚠️ 商品参数无效", true);
      return;
    }
    const kept = await beginOrderNote(env, chatId, itemId);
    await answerCallback(token, callback.id, "请回复备注内容");
    await sendMessage(
      token, chatId,
      `🧾 <b>填写下单备注</b>\n-------------------------\n` +
      (kept ? `当前备注：${escapeHtml(kept)}\n\n` : ``) +
      `请直接回复备注内容（例如想要的款式、联系方式或兑换要求）。\n` +
      `• 回复 <code>-</code> 可清空备注\n` +
      `• 发送 <code>/cancel</code> 放弃填写\n\n` +
      `备注会随订单一起发给管理员。`,
      "HTML"
    );
    return;
  }
  // 用户自助取消待处理订单并退款
  if (data.startsWith("shop_ucancel_")) {
    const parts = data.replace("shop_ucancel_", "").split("_");
    const orderId = parseInt(parts[0], 10);
    const page = parseInt(parts[1], 10) || 1;
    if (!Number.isInteger(orderId)) {
      await answerCallback(token, callback.id, "⚠️ 订单参数无效", true);
      return;
    }
    await handleUserCancelOrder(token, env, callback, userKey, orderId);
    await renderMyOrders(token, env, chatId, userKey, msgId, page);
    return;
  }

  // 用户自助退款已完成订单（仅「背包物品还没使用」的订单）
  if (data.startsWith("shop_urefund_")) {
    const parts = data.replace("shop_urefund_", "").split("_");
    const orderId = parseInt(parts[0], 10);
    const page = parseInt(parts[1], 10) || 1;
    if (!Number.isInteger(orderId)) {
      await answerCallback(token, callback.id, "⚠️ 订单参数无效", true);
      return;
    }
    await handleUserRefundOrder(token, env, callback, userKey, orderId);
    await renderMyOrders(token, env, chatId, userKey, msgId, page);
    return;
  }

  // ---------- 🎒 我的背包 ----------
  // 顺序注意：shop_bag_use_ 要排在 shop_bag_page_ 与 shop_bag_ 前面
  if (data.startsWith("shop_bag_use_")) {
    const parts = data.replace("shop_bag_use_", "").split("_");
    const bagId = parseInt(parts[0], 10);
    const page = parseInt(parts[1], 10) || 1;
    if (!Number.isInteger(bagId)) {
      await answerCallback(token, callback.id, "⚠️ 物品参数无效", true);
      return;
    }
    await handleUseBagItem({
      token, env, callback, chatId, userKey, messageId: msgId, bagId, page
    });
    return;
  }
  if (data.startsWith("shop_bag_page_")) {
    const page = parseInt(data.replace("shop_bag_page_", ""), 10) || 1;
    await renderBag(token, env, chatId, userKey, msgId, page);
    await answerCallback(token, callback.id, `第 ${page} 页`);
    return;
  }
  if (data === "shop_bag" || data.startsWith("shop_bag_")) {
    const page = parseInt(data.replace("shop_bag_", ""), 10) || 1;
    await renderBag(token, env, chatId, userKey, msgId, page);
    await answerCallback(token, callback.id, "我的背包");
    return;
  }

  // ---------- 自定义群组标签（购买后自动发放的引导流程）----------
  if (data.startsWith("shop_tag_grp_")) {
    const groupChatId = data.replace("shop_tag_grp_", "");
    await handleTagGroupPick({ token, env, callback, chatId, messageId: msgId, groupChatId });
    return;
  }
  if (data.startsWith("shop_tag_page_")) {
    const page = parseInt(data.replace("shop_tag_page_", ""), 10) || 1;
    const session = await getTagSession(env, chatId);
    if (!session) {
      await answerCallback(token, callback.id, "⌛️ 这次设置已经过期，请到「我的订单」重新进入", true);
      return;
    }
    await answerCallback(token, callback.id, `第 ${page} 页`);
    await renderTagGroupPicker(token, env, chatId, msgId, session, { page });
    return;
  }
  if (data.startsWith("shop_tag_order_")) {
    const orderId = parseInt(data.replace("shop_tag_order_", ""), 10);
    if (!Number.isInteger(orderId)) {
      await answerCallback(token, callback.id, "⚠️ 订单参数无效", true);
      return;
    }
    await handleTagOrderEntry({
      token, env, callback, chatId, userKey, userId: fromId, messageId: msgId, orderId
    });
    return;
  }
  if (data === "shop_tag_cancel") {
    await handleTagCancel({ token, env, callback, chatId, messageId: msgId });
    return;
  }

  // ==========================================
  // 2.5 积分流水翻页 / 积分排行榜（任何用户）
  // ==========================================
  if (data.startsWith("points_page_")) {
    const page = parseInt(data.replace("points_page_", ""), 10) || 1;
    await renderPointsLog(token, env, chatId, userKey, page, msgId);
    await answerCallback(token, callback.id, `第 ${page} 页`);
    return;
  }
  if (data === "rank_top") {
    await renderRank(token, env, chatId, msgId, userKey);
    await answerCallback(token, callback.id, "排行榜已刷新");
    return;
  }
  if (data === "rank_close") {
    await closeRank(token, chatId, msgId);
    await answerCallback(token, callback.id, "已关闭");
    return;
  }

  // ==========================================
  // 2.6 抽奖（任何用户，受 lottery 功能开关控制）
  // ==========================================
  if (data.startsWith("lottery_")) {
    if (!(await isFeatureEnabled(env, sceneKey, "lottery"))) {
      await answerCallback(token, callback.id, "⚠️ 本场景已关闭「每日抽奖」", true);
      return;
    }
    const { handleLotteryCallback } = await import("./commands/lottery.js");
    await handleLotteryCallback({ env, token, callback, chatId, userKey, messageId: msgId, data });
    return;
  }

  // ==========================================
  // 2.7 👋 入群验证按钮（任何成员都能点，因此放在管理员校验之前）
  // ==========================================
  // 只能通过**自己**的验证：user_id 取点击者，绝不从 callback_data 里带。
  if (data === ADMIN_CALLBACK.JOIN_VERIFY_OK) {
    await handleJoinVerifyCallback({
      env, token, callback, chatId, userId: fromId, messageId: msgId
    });
    return;
  }

  // ==========================================
  // 2.8 群规执法确认卡片（本群管理员也能点，因此放在管理员校验之前）
  // ==========================================
  // 走到这里才解析角色：游戏 / 商城 / 积分这些普通用户的按钮不会多查一次库
  role = await getAdminRole(env, fromId, { ownerId: myId });

  if (data.startsWith(ADMIN_CALLBACK.GUARD_PREFIX)) {
    await handleGuardCallback({ env, ctx, token, chatId, callback, data, myId, msgId, role });
    return;
  }

  // 申诉卡片（可能发到管理员私聊或群里的管理员）——同样放在管理员校验之前
  if (data.startsWith("appeal_")) {
    await handleAppealCallback({ env, ctx, token, callback, data, myId, chatId, msgId, role });
    return;
  }

  // ==========================================
  // 3. 管理员权限校验
  // ==========================================
  // v3.0.0：按「角色 + 能力」判定，不再只认拥有者（role 在上面的执法卡片分支前已解析）
  const needed = capabilityForCallback(data);
  if (!role || (needed && !can(role, needed))) {
    const hint = needed ? `该功能需要「${CAPABILITIES[needed]}」权限` : "需要管理员权限";
    await answerCallback(token, callback.id, `❌ 权限不足：${hint}`, true);
    return;
  }

  // 刷新管理员会话（30 分钟）；执法员不进后台，不需要会话
  if (env.DB && isBackstageRole(role)) {
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
  if (data === "shop_admin_add") {
    await startAddItem(token, env, chatId);
    await answerCallback(token, callback.id, "开始添加商品");
    return;
  }
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
  // 编辑商品：点某个字段后进入文本输入流程
  if (data.startsWith("shop_admin_editf_")) {
    const raw = data.replace("shop_admin_editf_", "");
    const sep = raw.lastIndexOf("_");
    const itemId = parseInt(sep === -1 ? raw : raw.slice(0, sep), 10);
    const field = sep === -1 ? "" : raw.slice(sep + 1);
    if (!Number.isInteger(itemId)) {
      await answerCallback(token, callback.id, "⚠️ 商品参数无效", true);
      return;
    }
    await startEditField({ env, token, chatId, itemId, field });
    await answerCallback(token, callback.id, "请按提示回复新内容");
    return;
  }
  if (data.startsWith("shop_admin_edit_")) {
    const itemId = parseInt(data.replace("shop_admin_edit_", ""), 10);
    await renderItemEditMenu(token, env, chatId, msgId, itemId);
    await answerCallback(token, callback.id, "编辑商品");
    return;
  }
  if (data.startsWith("shop_admin_toggle_")) {
    const itemId = parseInt(data.replace("shop_admin_toggle_", ""), 10);
    await actionToggleItem(token, env, callback, itemId, fromId);
    await renderShopAdminItem(token, env, chatId, msgId, itemId);
    return;
  }
  if (data.startsWith("shop_admin_del_")) {
    const itemId = parseInt(data.replace("shop_admin_del_", ""), 10);
    await actionDeleteItem(token, env, callback, itemId, fromId);
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
  if (data.startsWith("shop_admin_done_")) {
    const orderId = parseInt(data.replace("shop_admin_done_", ""), 10);
    await actionDone(token, env, callback, orderId, fromId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }
  if (data.startsWith("shop_admin_cancel_")) {
    const orderId = parseInt(data.replace("shop_admin_cancel_", ""), 10);
    await actionCancel(token, env, callback, orderId, fromId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }
  if (data.startsWith("shop_admin_refund_")) {
    const orderId = parseInt(data.replace("shop_admin_refund_", ""), 10);
    await actionRefund(token, env, callback, orderId, fromId);
    await renderShopAdminOrder(token, env, chatId, msgId, orderId);
    return;
  }

  // ==========================================
  // 4.5 群发消息（二次确认 / 继续发送）
  // ==========================================
  if (data === ADMIN_CALLBACK.BROADCAST_CONFIRM || data === ADMIN_CALLBACK.BROADCAST_CONTINUE) {
    await answerCallback(token, callback.id, "🚀 开始群发…");
    await startBroadcast({ env, ctx, token, chatId, messageId: msgId, adminId: fromId });
    return;
  }
  if (data === ADMIN_CALLBACK.BROADCAST_CANCEL) {
    await cancelBroadcast({ env, token, chatId, messageId: msgId, adminId: fromId });
    await answerCallback(token, callback.id, "已取消");
    return;
  }

  // ==========================================
  // 5. 其他管理员回调
  // ==========================================
  try {
    // ---------- 用户管理（一级点进来，二级再选私聊 / 群组）----------
    if (data === ADMIN_CALLBACK.USERS_HOME) {
      await renderUserManageMenu(token, chatId, msgId);
      await answerCallback(token, callback.id, "用户管理");
    }

    // ---------- 群组用户：群列表 → 群成员 ----------
    else if (data.startsWith(ADMIN_CALLBACK.GROUP_MEMBERS_PREFIX)) {
      // 形如 admin_group_m_-1001234567890_2：群 ID 可能是负数，用最后一个下划线切页码
      const rest = String(data).replace(ADMIN_CALLBACK.GROUP_MEMBERS_PREFIX, "");
      const sep = rest.lastIndexOf("_");
      const targetChat = sep === -1 ? rest : rest.slice(0, sep);
      const page = Number.parseInt(sep === -1 ? "1" : rest.slice(sep + 1), 10) || 1;
      await renderGroupMembersMenu(token, env, chatId, msgId, targetChat, page);
      await answerCallback(token, callback.id, `群 ${targetChat}`);
    }
    else if (data.startsWith(ADMIN_CALLBACK.USER_GROUPS_PREFIX)) {
      const page = Number.parseInt(String(data).replace(ADMIN_CALLBACK.USER_GROUPS_PREFIX, ""), 10) || 1;
      await renderGroupListMenu(token, env, chatId, msgId, page);
      await answerCallback(token, callback.id, `群组第 ${page} 页`);
    }

    // ---------- 封禁名单 ----------
    else if (data.startsWith(ADMIN_CALLBACK.UNBAN_PREFIX)) {
      await handleUnban({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.BANNED_PREFIX)) {
      const page = Number.parseInt(String(data).replace(ADMIN_CALLBACK.BANNED_PREFIX, ""), 10) || 1;
      await renderBannedListMenu(token, env, chatId, msgId, page);
      await answerCallback(token, callback.id, `封禁名单第 ${page} 页`);
    }

    // ---------- 知识库（RAG）----------
    else if (data === ADMIN_CALLBACK.KB_HOME) {
      await renderKnowledgeHome(token, env, chatId, msgId, uctx);
      await answerCallback(token, callback.id, "知识库");
    }
    else if (data === ADMIN_CALLBACK.KB_ADD) {
      await startAddDocument({ env, token, chatId, uctx });
      await answerCallback(token, callback.id, "开始添加文档");
    }
    else if (data === ADMIN_CALLBACK.KB_TEST) {
      await startKnowledgeTest({ env, token, chatId, uctx });
      await answerCallback(token, callback.id, "请输入要测试的问题");
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_LIST_PREFIX)) {
      const page = Number.parseInt(String(data).replace(ADMIN_CALLBACK.KB_LIST_PREFIX, ""), 10) || 1;
      await renderDocumentList(token, env, chatId, msgId, uctx, page);
      await answerCallback(token, callback.id, `文档第 ${page} 页`);
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_TOGGLE_PREFIX)) {
      await handleDocumentToggle({ env, token, callback, chatId, msgId, data, uctx, adminId: fromId });
    }
    else if (data === ADMIN_CALLBACK.KB_REINDEX) {
      await handleKnowledgeReindex({ env, token, callback, chatId, msgId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_PROMOTE_PREFIX)) {
      await handleDocPromote({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_COPY_PREFIX)) {
      await handleDocCopy({ env, token, callback, chatId, msgId, data, uctx, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_DELOK_PREFIX)) {
      await handleDocumentDeleteConfirm({ env, token, callback, chatId, msgId, data, uctx, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_DEL_PREFIX)) {
      await handleDocumentDelete({ env, token, callback, chatId, msgId, data });
    }
    else if (data.startsWith(ADMIN_CALLBACK.KB_DOC_PREFIX)) {
      const docId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.KB_DOC_PREFIX, ""), 10);
      if (Number.isInteger(docId)) {
        await renderDocumentDetail(token, env, chatId, msgId, docId, uctx);
        await answerCallback(token, callback.id, `文档 #${docId}`);
      } else {
        await answerCallback(token, callback.id, "⚠️ 文档参数无效", true);
      }
    }

    // ---------- 群规执法面板 ----------
    else if (data.startsWith(ADMIN_CALLBACK.GUARD_HOME)) {
      await handleGuardPanelCallback({ env, token, callback, chatId, msgId, data, uctx, adminId: fromId });
    }

    // ---------- 👋 入群欢迎与验证面板 ----------
    else if (data.startsWith(ADMIN_CALLBACK.WELCOME_HOME)) {
      await handleWelcomeCallback({
        env, ctx, token, callback, data, chatId, userId: fromId, messageId: msgId
      });
    }

    // ---------- 用户列表 ----------
    else if (data.startsWith(ADMIN_CALLBACK.USERS_PRIVATE_PREFIX)) {
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
    else if (data.startsWith("admin_detail_")) {
      const rowId = Number.parseInt(data.replace("admin_detail_", ""), 10);
      await renderUserDetail(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, "用户详情");
    }
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
      await handleModPoints({ env, token, callback, chatId, msgId, data, adminId: fromId });
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
      await handleModLimit({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }

    // ---------- 频率 ----------
    else if (data.startsWith(ADMIN_CALLBACK.MENU_RATE_PREFIX)) {
      const rowId = parseInt(data.replace(ADMIN_CALLBACK.MENU_RATE_PREFIX, ""), 10);
      await renderUserRateMenu(token, env, chatId, msgId, rowId);
      await answerCallback(token, callback.id, "加载频率设置");
    }
    else if (data.startsWith(ADMIN_CALLBACK.SETRATE_PREFIX)) {
      await handleSetRate({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }

    // ---------- 封禁 / 解封 ----------
    else if (data.startsWith(ADMIN_CALLBACK.BLOCK_PREFIX)) {
      await handleToggleBlock({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }

    // ---------- 清空某群某用户记忆 ----------
    else if (data.startsWith(ADMIN_CALLBACK.CLEARMEM_PREFIX)) {
      await handleClearSceneMemory({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }

    // ---------- 操作日志 ----------
    else if (data.startsWith(ADMIN_CALLBACK.LOGS_FILTER_PREFIX)) {
      // 形如 admin_logs_f_guard_2
      const raw = String(data).replace(ADMIN_CALLBACK.LOGS_FILTER_PREFIX, "");
      const sep = raw.lastIndexOf("_");
      const filter = sep === -1 ? raw : raw.slice(0, sep);
      const page = Number.parseInt(sep === -1 ? "1" : raw.slice(sep + 1), 10) || 1;
      await renderAdminLogs(token, env, chatId, msgId, page, filter);
      await answerCallback(token, callback.id, `${filter} 第 ${page} 页`);
    }
    else if (data.startsWith(ADMIN_CALLBACK.LOGS_PREFIX)) {
      const page = parseInt(data.replace(ADMIN_CALLBACK.LOGS_PREFIX, ""), 10) || 1;
      await renderAdminLogs(token, env, chatId, msgId, page);
      await answerCallback(token, callback.id, `操作日志第 ${page} 页`);
    }

    // ---------- 兑换码 ----------
    else if (data.startsWith(ADMIN_CALLBACK.CODE_TOGGLE_PREFIX)) {
      await handleCodeToggle({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.CODES_PREFIX)) {
      const page = parseInt(data.replace(ADMIN_CALLBACK.CODES_PREFIX, ""), 10) || 1;
      await renderCodeList(token, env, chatId, msgId, page);
      await answerCallback(token, callback.id, `兑换码第 ${page} 页`);
    }

    // ---------- 功能开关 ----------
    else if (data === ADMIN_CALLBACK.FEATURES_HOME) {
      await renderFeatureHome(token, env, chatId, msgId);
      await answerCallback(token, callback.id, "功能开关");
    }

    // ---------- 🗑️ 消息自动删除 ----------
    else if (
      data === ADMIN_CALLBACK.AUTO_DELETE_HOME
      || data === ADMIN_CALLBACK.AUTO_DELETE_CAP
      || data.startsWith(ADMIN_CALLBACK.AUTO_DELETE_CAP_SET_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.AUTO_DELETE_KIND_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.AUTO_DELETE_SET_PREFIX)
    ) {
      await handleAutoDeleteCallback({
        env, token, callback, chatId, msgId, data, uctx, adminId: fromId
      });
    }
    else if (data.startsWith(ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX)) {
      await handleFeatureToggle({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.FEATURES_RESET_PREFIX)) {
      await handleFeatureReset({ env, token, callback, chatId, msgId, data, adminId: fromId });
    }
    else if (data.startsWith(ADMIN_CALLBACK.FEATURES_GROUP_PREFIX)) {
      await renderFeatureScope(token, env, chatId, msgId, `gl${parseInt(data.replace(ADMIN_CALLBACK.FEATURES_GROUP_PREFIX, ""), 10) || 1}`);
      await answerCallback(token, callback.id, "群聊场景");
    }
    else if (data.startsWith(ADMIN_CALLBACK.FEATURES_PRIVATE_PREFIX)) {
      await renderFeatureScope(token, env, chatId, msgId, `pl${parseInt(data.replace(ADMIN_CALLBACK.FEATURES_PRIVATE_PREFIX, ""), 10) || 1}`);
      await answerCallback(token, callback.id, "私聊场景");
    }
    else if (data.startsWith(ADMIN_CALLBACK.FEATURES_SCENE_PREFIX)) {
      // ⚠️ 这里**不能** parseInt：scopeToken 有两种形态 ——
      //   `s<行ID>`（私聊/成员场景）与 `gc<群ID>`（群级，ID 是负数且带前缀）。
      // parseInt 会把 gc-100123 变成 NaN，点进去只会得到「参数无效」。
      const scopeToken = data.replace(ADMIN_CALLBACK.FEATURES_SCENE_PREFIX, "");
      await renderFeatureScope(token, env, chatId, msgId, scopeToken);
      await answerCallback(token, callback.id, scopeToken.startsWith("gc") ? "本群功能开关" : "场景功能开关");
    }
    else if (data === ADMIN_CALLBACK.FEATURES_GLOBAL) {
      await renderFeatureScope(token, env, chatId, msgId, "g");
      await answerCallback(token, callback.id, "全局设置");
    }

    // ---------- 👑 管理员与权限（仅拥有者）----------
    else if (data === ADMIN_CALLBACK.ADMINS_HOME
      || data.startsWith(ADMIN_CALLBACK.ADMINS_ADD)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_HELP)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_PAGE_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_USER_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_SET_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_DELOK_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_DEL_PREFIX)
      || data.startsWith(ADMIN_CALLBACK.ADMINS_GUIDE_ROLE_PREFIX)) {
      await handleAdminsCallback({
        env, token, callback, chatId, msgId, data, adminId: fromId, uctx
      });
    }

    // ---------- 删除场景 ----------
    else if (data.startsWith(ADMIN_CALLBACK.DELUSER_DONE_PREFIX)) {
      await handleDeleteScene({
        env, token, callback, chatId, msgId, data,
        renderUserListMenu,
        adminId: fromId
      });
    }
    else if (data.startsWith(ADMIN_CALLBACK.DELUSER_PREFIX)) {
      await confirmDeleteScene({ env, token, callback, chatId, msgId, data });
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
      await renderAdminMainMenu(token, chatId, msgId, showShop, role);
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
