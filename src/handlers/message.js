// ==========================================
// 💬 普通消息总入口
// 1. 群聊里只处理 @BOT 或 /指令
// 2. 引导式文本输入（添加/编辑商品、订单备注）
// 3. 指令 → 命令注册表（权限 / 仅私聊 / 功能开关都在注册表里判定）
// 4. 非指令 → AI 对话
//
// 注意各段判断的先后顺序：引导式输入必须排在指令分发之前，
// 否则用户正在填写的表单内容会被当成未知指令丢掉。
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
import {
  ingestUploadedDocument, isKnowledgeGuideActive, handleKnowledgeInput, cancelKnowledgeGuide
} from "../admin/knowledge.js";
import { looksLikeGuardCommand } from "../services/guard.js";
import { handleGuardRequest } from "../admin/guard.js";

/** 处理 message / edited_message 更新 */
export async function handleMessage({ env, ctx, token, myId, uctx, payload, isGroupCtx }) {
  const message = payload.message || payload.edited_message;
  // 原始文本（保留 @提及 与实体偏移），群规执法解析要用它
  const originalText = (message.text || "").trim();
  let userText = (message.text || "").trim();

  const chatId = uctx.chatId;
  const userKey = uctx.userKey;
  const sceneKey = uctx.sceneKey;
  const userId = uctx.userId;

  // ---------- 管理员上传知识库文件（.txt / .md）：在文本判定之前处理 ----------
  // 只处理管理员发的「文档」消息，图片 / 语音等仍然走原来的忽略逻辑
  if (!userText && message.document && myId && userId === myId) {
    const handled = await ingestUploadedDocument({
      env, token, chatId, uctx, document: message.document, adminId: userId
    });
    if (handled) return;

    // 管理员发了不支持的文件类型时给个提示，避免以为机器人没反应
    await sendMessage(
      token, chatId,
      "ℹ️ 只支持把 <code>.txt</code> / <code>.md</code> 等文本文件直接存进知识库。\n" +
      "其他格式（图片、压缩包、PDF）请转换成文本后，用「📚 知识库 → ➕ 添加文档」粘贴进来。",
      "HTML"
    );
    return;
  }

  if (!userText) return;

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

    // 管理员正在填知识库引导表单时，群里不 @ 也要放行（否则粘贴正文会被静默丢掉）
    if (!isMentioned && !isCommandLike) {
      const adminGuideActive = Boolean(myId && userId === myId)
        && await isKnowledgeGuideActive(env, chatId);
      if (!adminGuideActive) return;
    }

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
      // 只去掉发往本机器人的 @用户名，保留正文里提到的其他人
      userText = userText.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
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

  // ---------- 群规执法：群里 @机器人 说「封禁 @某人 发广告」----------
  // 放在封禁校验之后：被封禁的用户即便自称管理员也进不来
  if (isGroupCtx && isMentioned && looksLikeGuardCommand(originalText)) {
    const handled = await handleGuardRequest({
      env, token, chatId, uctx, message, rawText: originalText, myId, isGroupCtx
    });
    if (handled) return;
  }

  const command = userText.split(/\s+/)[0].split("@")[0].toLowerCase();
  const botMention = botUsername ? `@${botUsername}` : "Bot";

  // 指令处理用的复合上下文：`ctx` 字段是 Worker 原生 ctx（sendAutoDelete 会从中取 waitUntil）
  const baseCtx = {
    env, ctx, token, chatId, userKey, sceneKey,
    uctx, userConfig, isGroupCtx, isMaster,
    firstName, username, rawText: userText, command, botMention,
    myId,
    // 原始消息与未清洗文本：群规执法要拿实体偏移和 @提及
    message, originalText
  };

  // ---------- 管理员引导式文本输入（添加商品 / 编辑商品字段）----------
  // 这两个流程互斥，任何一个命中都会消费掉本条消息
  if (!isGroupCtx && isMaster && !isCommandLike) {
    if (await handleAddItemInput({ env, token, chatId, userText, adminId: userId })) return;
    if (await handleEditItemInput({ env, token, chatId, userText, adminId: userId })) return;
  }

  // ---------- 知识库引导式输入（添加文档 / 检索测试，私聊与群聊都支持）----------
  if (isMaster && (await isKnowledgeGuideActive(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await cancelKnowledgeGuide({ env, token, chatId });
        return;
      }
    } else if (await handleKnowledgeInput({ env, token, chatId, uctx, userText, adminId: userId })) {
      return;
    }
  }

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

  // ---------- 商城下单备注输入（私聊，任何用户）----------
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
