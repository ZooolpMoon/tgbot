// ==========================================
// 💬 普通消息总入口
// 1. 群聊里只处理 @BOT 或 /指令
// 2. 指令分发
// 3. 非指令 → AI 对话
// ==========================================

import { sendAutoDelete } from "../telegram/auto-delete.js";
import { dispatchCommand } from "./commands/index.js";
import {
  cmdUsersPrivate,
  cmdUsersGroup,
  cmdStats,
  cmdAddPoints,
  cmdAdminRoot
} from "./commands/admin/index.js";
import { handleAIRequest } from "./ai.js";
import { upsertUserInfo, loadUserConfig } from "../services/users.js";
import { ERR } from "../config/messages.js";
import { cmdShop } from "./commands/shop.js";

export async function handleMessage({ env, ctx, token, myId, uctx, payload, isGroupCtx }) {
  const message = payload.message || payload.edited_message;
  let userText = (message.text || "").trim();
  if (!userText) return;

  const chatId = uctx.chatId;
  const userKey = uctx.userKey;
  const sceneKey = uctx.sceneKey;
  const userId = uctx.userId;

  // 群聊里：只处理 @BOT 或 /指令
  const botUsername = env.BOT_USERNAME ? env.BOT_USERNAME.replace(/^@/, "").trim().toLowerCase() : null;
  let isMentioned = false;
  let isCommandLike = userText.startsWith("/");

  if (isGroupCtx) {
    if (botUsername) {
      isMentioned = userText.toLowerCase().includes(`@${botUsername}`);
    } else {
      const entities = message.entities?.some(e => e.type === "mention" || e.type === "bot_command");
      isMentioned = userText.includes("@") || Boolean(entities);
    }

    if (!isMentioned && !isCommandLike) return;

    if (isMentioned) {
      if (botUsername) {
        userText = userText.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
      } else {
        userText = userText.replace(/@\w+/g, "").trim();
      }
      if (!userText) return;
      isCommandLike = userText.startsWith("/");
    }
  } else {
    isMentioned = true;
  }

  const username = uctx.username ? `@${uctx.username}` : "无用户名";
  const firstName = uctx.firstName || "未命名";

  if (env.DB) await upsertUserInfo(env, uctx);

  const isMaster = Boolean(myId && userId === myId);

  // 读取配置
  const userConfig = await loadUserConfig(env, userKey, sceneKey);

  // 解析指令
  const command = userText.split(/\s+/)[0].split("@")[0].toLowerCase();

  const baseCtx = {
    env, ctx, token, chatId, userKey, sceneKey,
    uctx, userConfig, isGroupCtx, isMaster,
    firstName, username, rawText: userText,
    myId
  };

  // ==========================================
  // 管理员指令（需先 /admin 解锁）
  // ==========================================
  if (command === "/users" || command === "/users_private") {
    return cmdUsersPrivate(baseCtx);
  }
  if (command === "/users_group") {
    return cmdUsersGroup(baseCtx);
  }
  if (command === "/stats") {
    return cmdStats(baseCtx);
  }
  if (command === "/addpoints") {
    return cmdAddPoints(baseCtx);
  }
  if (command === "/admin") {
    return cmdAdminRoot(baseCtx);
  }

  // ==========================================
  // 商城：用户侧
  // ==========================================
  if (command === "/shop" || command === "/store") {
    if (isGroupCtx) {
      await sendAutoDelete(
        token, chatId,
        "🛒 商城功能仅支持<b>私聊</b>使用。\n\n请点击下方链接直接与 Bot 私聊：\n👉 私聊我：@Zooolp_bot",
        "HTML", isGroupCtx, ctx
      );
      return;
    }
    return cmdShop(baseCtx);
  }

  if (command === "/orders" || command === "/myorders") {
    if (isGroupCtx) {
      await sendAutoDelete(
        token, chatId,
        "📜 订单查询仅支持<b>私聊</b>使用。",
        "HTML", isGroupCtx, ctx
      );
      return;
    }
    const { cmdOrders } = await import("./commands/orders.js");
    return cmdOrders(baseCtx);
  }

  // ==========================================
  // 商城：管理员侧快捷指令
  // ==========================================
  if (command === "/shop_admin") {
    if (!isMaster) {
      await sendAutoDelete(token, chatId, "❌ 权限不足", null, isGroupCtx, ctx);
      return;
    }
    if (isGroupCtx) {
      await sendAutoDelete(token, chatId, "🛒 商城管理仅支持私聊使用", null, isGroupCtx, ctx);
      return;
    }
    const { renderShopAdmin } = await import("../shop/admin.js");
    await renderShopAdmin(token, env, chatId, null);
    return;
  }

  // ==========================================
  // 通用指令
  // ==========================================
  const handled = await dispatchCommand(command, baseCtx);
  if (handled) return;

  // 未知指令
  if (userText.startsWith("/")) {
    await sendAutoDelete(token, chatId, ERR.UNKNOWN_CMD, null, isGroupCtx, ctx);
    return;
  }

  // 非指令 → AI 对话
  return handleAIRequest({
    env, ctx, token, chatId, userKey, sceneKey, isGroupCtx, isMaster,
    firstName, userText, userConfig
  });
}