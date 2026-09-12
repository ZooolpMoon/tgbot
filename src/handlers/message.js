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
  cmdAdminRoot,
  checkAdminUnlocked
} from "./commands/admin/index.js";
import { handleAIRequest } from "./ai.js";
import { upsertUserInfo, loadUserConfig } from "../services/users.js";
import { ERR } from "../config/messages.js";
import { cmdShop } from "./commands/shop.js";
import { startAddItem, cancelAddItem, handleAddItemInput } from "../shop/add.js";
import { cmdShopEdit, handleEditItemInput } from "../shop/edit.js";
import { cmdRank } from "./commands/rank.js";
import { cmdBroadcast } from "./commands/broadcast.js";
import { cmdClearMem } from "./commands/clearmem.js";

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
      const mentionEntities = Array.isArray(message.entities)
        ? message.entities.filter(e => e.type === "mention")
        : [];
      isMentioned = mentionEntities.some(e => {
        const mentionText = userText.slice(e.offset || 0, (e.offset || 0) + (e.length || 0));
        return mentionText.toLowerCase() === `@${botUsername}`;
      });
      if (!isMentioned) {
        isMentioned = userText.toLowerCase().includes(`@${botUsername}`);
      }
    } else {
      isMentioned = Array.isArray(message.entities)
        ? message.entities.some(e => e.type === "mention" || e.type === "bot_command")
        : false;
      if (!isMentioned) {
        const mentionNames = [...userText.matchAll(/@([\w]+)/g)].map(m => m[1].toLowerCase());
        isMentioned = mentionNames.some(name => name.includes("bot"));
      }
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

  // 忽略发给其他机器人的指令（例如 /start@OtherBot）
  if (botUsername && isCommandLike) {
    const firstToken = userText.split(/\s+/)[0] || "";
    if (firstToken.includes("@")) {
      const target = firstToken.split("@").slice(1).join("@").toLowerCase();
      if (target && target !== botUsername) return;
      userText = userText.replace(/@\w+/g, "").trim();
      if (!userText) return;
    }
  }

  const username = uctx.username ? `@${uctx.username}` : "无用户名";
  const firstName = uctx.firstName || "未命名";

  if (env.DB) await upsertUserInfo(env, uctx);

  const isMaster = Boolean(myId && userId === myId);

  // 读取配置
  const userConfig = await loadUserConfig(env, userKey, sceneKey);

  // ==========================================
  // 🚫 封禁校验（管理员不受限）
  // ==========================================
  if (userConfig.blocked && !isMaster) {
    await sendAutoDelete(token, chatId, ERR.BLOCKED, null, isGroupCtx, ctx);
    return;
  }

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
  // 📢 管理员群发（私聊 + 需先 /admin 解锁）
  // ==========================================
  if (command === "/broadcast" || command === "/announce") {
    if (isGroupCtx) {
      await sendAutoDelete(token, chatId, "📢 群发消息仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
      return;
    }
    if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
      return;
    }
    return cmdBroadcast(baseCtx);
  }

  // ==========================================
  // 🧹 清除指定场景/群组 AI 记忆（管理员）
  // ==========================================
  if (command === "/clearmem" || command === "/clearmemory") {
    if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
      return;
    }
    return cmdClearMem(baseCtx);
  }

  // ==========================================
  // 🏆 积分排行榜（所有用户）
  // ==========================================
  if (command === "/rank" || command === "/top" || command === "/leaderboard") {
    return cmdRank(baseCtx);
  }

  // ==========================================
  // 商城：用户侧
  // ==========================================
  if (command === "/shop" || command === "/store") {
    if (isGroupCtx) {
      const botMention = botUsername ? `@${botUsername}` : "Bot";
      await sendAutoDelete(
        token, chatId,
        `🛒 商城功能仅支持<b>私聊</b>使用。\n\n请点击下方链接直接与 Bot 私聊：\n👉 私聊我：${botMention}`,
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
    if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
      return;
    }
    const { renderShopAdmin } = await import("../shop/admin.js");
    await renderShopAdmin(token, env, chatId, null);
    return;
  }

  // ==========================================
  // 商城：管理员添加商品
  // ==========================================
  if (command === "/shop_add") {
    if (!isMaster) {
      await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, ctx);
      return;
    }
    if (isGroupCtx) {
      await sendAutoDelete(token, chatId, "🛒 添加商品仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
      return;
    }
    if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
      return;
    }
    const addArg = userText.split(/\s+/).slice(1).join(" ").trim().toLowerCase();
    if (addArg === "cancel" || addArg === "取消") {
      await cancelAddItem(token, env, chatId);
    } else {
      await startAddItem(token, env, chatId);
    }
    return;
  }

  // ==========================================
  // 商城：管理员编辑商品
  // ==========================================
  if (command === "/shop_edit" || command === "/edititem") {
    if (!isMaster) {
      await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, ctx);
      return;
    }
    if (isGroupCtx) {
      await sendAutoDelete(token, chatId, "🛒 商品编辑仅支持<b>私聊</b>使用。", "HTML", isGroupCtx, ctx);
      return;
    }
    if (!(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, ctx);
      return;
    }
    return cmdShopEdit(baseCtx);
  }

  // 管理员引导流程的文本输入（添加商品 / 编辑商品字段）
  if (!isGroupCtx && isMaster && !isCommandLike) {
    const addHandled = await handleAddItemInput({ env, token, chatId, userText, adminId: userId });
    if (addHandled) return;

    const editHandled = await handleEditItemInput({ env, token, chatId, userText, adminId: userId });
    if (editHandled) return;
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
