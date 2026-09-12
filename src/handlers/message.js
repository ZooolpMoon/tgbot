// ==========================================
// 💬 普通消息总入口
// 1. 群聊里只处理 @BOT 或 /指令
// 2. 引导式文本输入（添加/编辑商品、订单备注）
// 3. 指令 → 命令注册表（权限 / 仅私聊 / 功能开关都在注册表里判定）
// 4. 非指令 → AI 对话
// ==========================================

import { sendAutoDelete } from "../telegram/auto-delete.js";
import { sendMessage } from "../telegram/api.js";
import { dispatchCommand } from "./commands/registry.js";
import { handleAIRequest } from "./ai.js";
import { upsertUserInfo, loadUserConfig } from "../services/users.js";
import { isFeatureEnabled, featureLabel } from "../services/features.js";
import { ERR } from "../config/messages.js";
import { handleAddItemInput } from "../shop/add.js";
import { handleEditItemInput } from "../shop/edit.js";
import { renderShopItem } from "../shop/index.js";
import { getPendingNoteRequest, saveOrderNote, cancelOrderNote } from "../shop/notes.js";
import { isTaskGuideActive, handleTaskGuideInput, cancelTaskGuide } from "../admin/tasks.js";

export async function handleMessage({ env, ctx, token, myId, uctx, payload, isGroupCtx }) {
  const message = payload.message || payload.edited_message;
  let userText = (message.text || "").trim();
  if (!userText) return;

  const chatId = uctx.chatId;
  const userKey = uctx.userKey;
  const sceneKey = uctx.sceneKey;
  const userId = uctx.userId;

  // ---------- 群聊里：只处理 @BOT 或 /指令 ----------
  const botUsername = env.BOT_USERNAME ? env.BOT_USERNAME.replace(/^@/, "").trim().toLowerCase() : null;
  let isMentioned = false;
  let isCommandLike = userText.startsWith("/");

  if (isGroupCtx) {
    if (botUsername) {
      const mentionEntities = Array.isArray(message.entities)
        ? message.entities.filter((e) => e.type === "mention")
        : [];
      isMentioned = mentionEntities.some((e) => {
        const mentionText = userText.slice(e.offset || 0, (e.offset || 0) + (e.length || 0));
        return mentionText.toLowerCase() === `@${botUsername}`;
      });
      if (!isMentioned) isMentioned = userText.toLowerCase().includes(`@${botUsername}`);
    } else {
      isMentioned = Array.isArray(message.entities)
        ? message.entities.some((e) => e.type === "mention" || e.type === "bot_command")
        : false;
      if (!isMentioned) {
        const mentionNames = [...userText.matchAll(/@([\w]+)/g)].map((m) => m[1].toLowerCase());
        isMentioned = mentionNames.some((name) => name.includes("bot"));
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
  const userConfig = await loadUserConfig(env, userKey, sceneKey);

  // ---------- 封禁校验（管理员不受限）----------
  if (userConfig.blocked && !isMaster) {
    await sendAutoDelete(token, chatId, ERR.BLOCKED, null, isGroupCtx, ctx);
    return;
  }

  const command = userText.split(/\s+/)[0].split("@")[0].toLowerCase();
  const botMention = botUsername ? `@${botUsername}` : "Bot";

  const baseCtx = {
    env, ctx, token, chatId, userKey, sceneKey,
    uctx, userConfig, isGroupCtx, isMaster,
    firstName, username, rawText: userText, command, botMention,
    myId
  };

  // ---------- 管理员引导式文本输入（添加商品 / 编辑商品字段）----------
  if (!isGroupCtx && isMaster && !isCommandLike) {
    if (await handleAddItemInput({ env, token, chatId, userText, adminId: userId })) return;
    if (await handleEditItemInput({ env, token, chatId, userText, adminId: userId })) return;
  }

  // ---------- 商城下单备注输入（私聊，任何用户）----------
  // ---------- 每日任务管理的引导式输入（管理员，私聊）----------
  if (!isGroupCtx && isMaster && (await isTaskGuideActive(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await cancelTaskGuide({ env, token, chatId });
        return;
      }
    } else if (await handleTaskGuideInput({ env, token, chatId, userText, adminId: userId })) {
      return;
    }
  }

  if (!isGroupCtx) {
    const pendingNote = await getPendingNoteRequest(env, chatId);
    if (pendingNote) {
      if (isCommandLike) {
        // 输入备注期间仍然允许用指令；只有 /cancel 用来放弃填写
        if (/^\/(cancel|取消)$/i.test(command)) {
          await cancelOrderNote(env, chatId);
          await sendMessage(token, chatId, "🚫 已取消填写备注。");
          return;
        }
      } else {
        const saved = await saveOrderNote(env, chatId, userText);
        await sendMessage(token, chatId, saved ? `✅ 备注已保存：\n${saved}` : "🧹 已清空备注。");
        await renderShopItem(token, env, chatId, userKey, null, pendingNote.itemId);
        return;
      }
    }
  }

  // ---------- 指令 ----------
  if (await dispatchCommand(userText, baseCtx)) return;

  if (userText.startsWith("/")) {
    await sendAutoDelete(token, chatId, ERR.UNKNOWN_CMD, null, isGroupCtx, ctx);
    return;
  }

  // ---------- 非指令 → AI 对话 ----------
  if (!(await isFeatureEnabled(env, sceneKey, "ai"))) {
    await sendAutoDelete(
      token, chatId,
      `⚠️ 本场景已关闭「${featureLabel("ai")}」，如需使用请联系管理员。`,
      null, isGroupCtx, ctx
    );
    return;
  }

  return handleAIRequest({
    env, ctx, token, chatId, userKey, sceneKey, isGroupCtx, isMaster,
    firstName, userText, userConfig
  });
}
