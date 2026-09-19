// ==========================================
// 💬 普通消息总入口
// 1. 群聊里只处理 @BOT 或 /指令
// 2. 引导式文本输入（添加/编辑商品、订单备注）
// 3. 指令 → 命令注册表（权限 / 仅私聊 / 功能开关都在注册表里判定）
// 4. 非指令 → AI 对话
//
// 处置类动作（封禁 / 踢出 / 禁言 / 举报 / 申诉）一律要求 /指令，
// 不再从自然语言里猜意图——「封禁」「拉黑」这类词在正常聊天里太常见，
// 靠关键词拦截会把普通发言误当成指令（见 AGENTS.md）。
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
import { logError } from "../core/logger.js";
import {
  ingestUploadedDocument, isKnowledgeGuideActive, handleKnowledgeInput, cancelKnowledgeGuide
} from "../admin/knowledge.js";
import { handleKeywordAlert } from "../admin/guard.js";
import { isGuardGuideActive, handleGuardGuideInput, cancelGuardGuide } from "../admin/guard-panel.js";
import { isAdminGuideActive, handleAdminGuideInput, cancelAdminGuide } from "../admin/admins.js";
import { can, getAdminRole, isBackstageRole } from "../services/admins.js";
import { getTagSession, handleTagCancel, handleTagInput } from "../shop/tags.js";

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

  // ---------- 管理员上传知识库文件（.txt / .md / .docx / .pdf）----------
  // 放在最前面：带说明文字的文档（caption）也要能入库，不能被文本判定挡掉
  if (message.document && myId && userId === myId) {
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

  // ---------- 身份与角色 ----------
  // owner = 环境变量里的 MY_TELEGRAM_ID；admin / moderator 来自 bot_admins 表
  // （读取带 60 秒 isolate 缓存，不会每条消息都查库）
  const isMaster = Boolean(myId && userId === myId);
  const role = await getAdminRole(env, userId, { ownerId: myId });
  // 引导式输入的门禁必须与「按钮 / 指令」用**同一套 capability**（v3.8.0 统一）：
  // 原先这几处只认 owner，于是 admin 点了「添加文档 / 编辑群规 / 添加商品」之后，
  // 他回复的正文不会被对应流程消费 —— 私聊里还会掉进 AI 对话，扣 1 积分且正文永久丢失。
  const canManageShop = Boolean(role) && can(role, "manage_shop");
  const canManageKb = Boolean(role) && can(role, "manage_kb");
  const canManageGuard = Boolean(role) && can(role, "manage_guard");

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

    // 管理员正在填「知识库 / 群规」引导表单时，群里不 @ 也要放行（否则粘贴正文会被静默丢掉）
    if (!isMentioned && !isCommandLike) {
      const canManageAdmins = Boolean(role) && can(role, "manage_admins");
      const adminGuideActive = canManageAdmins
        && (
          (await isKnowledgeGuideActive(env, chatId))
          || (await isGuardGuideActive(env, chatId))
          || (await isAdminGuideActive(env, chatId))
        );
      if (!adminGuideActive) {
        // 静默预警：普通群聊发言（没 @机器人）同样可能违规，
        // 这里只私聊提醒管理员，不公开任何内容，也不打断群聊。
        // 所有人都要过这一关，管理员 / owner 也不例外（群规对谁都一样）。
        if (env.DB) {
          try {
            await handleKeywordAlert({
              env, token, chatId, uctx, message, rawText: originalText, myId, ctx
            });
          } catch (e) {
            logError("关键词预警失败：", e);
          }
        }
        return;
      }
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

  const userConfig = await loadUserConfig(env, userKey, sceneKey);

  // ---------- 封禁校验（机器人管理员不受限）----------
  // 用 role 而不是 isMaster：owner / admin / moderator 都该豁免。
  // 正常途径已经封不了管理员（banUserById / setUserBlocked 会拒绝），
  // 这里兜住「先被封、后授权」的历史数据，否则他连 /unban 都发不出去。
  if (userConfig.blocked && !role) {
    await sendAutoDelete(token, chatId, ERR.BLOCKED, null, isGroupCtx, ctx, {
      kind: "cmd", env, sceneKey
    });
    return;
  }

  const command = userText.split(/\s+/)[0].split("@")[0].toLowerCase();
  const botMention = botUsername ? `@${botUsername}` : "Bot";

  // 指令处理用的复合上下文：`ctx` 字段既能取到 Worker 的 waitUntil，
  // 也带上 env / sceneKey —— sendAutoDelete 靠它按场景查「自动删除」设置。
  // （原生 ExecutionContext 挂在 .ctx 上，方便需要原始对象时取用）
  const workerCtx = ctx;
  const sceneCtx = {
    env,
    sceneKey,
    ctx: workerCtx,
    waitUntil: typeof workerCtx?.waitUntil === "function"
      ? (promise) => workerCtx.waitUntil(promise)
      : undefined
  };

  const baseCtx = {
    env, ctx: sceneCtx, token, chatId, userKey, sceneKey,
    uctx, userConfig, isGroupCtx, isMaster, role,
    firstName, username, rawText: userText, command, botMention,
    myId,
    // 原始消息与未清洗文本：群规执法要拿实体偏移和 @提及
    message, originalText
  };

  // ---------- 管理员引导式文本输入（添加商品 / 编辑商品字段）----------
  // 这两个流程互斥，任何一个命中都会消费掉本条消息
  if (!isGroupCtx && canManageShop && !isCommandLike) {
    if (await handleAddItemInput({ env, token, chatId, userText, adminId: userId })) return;
    if (await handleEditItemInput({ env, token, chatId, userText, adminId: userId })) return;
  }

  // ---------- 知识库引导式输入（添加文档 / 检索测试，私聊与群聊都支持）----------
  if (canManageKb && (await isKnowledgeGuideActive(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await cancelKnowledgeGuide({ env, token, chatId });
        return;
      }
    } else if (await handleKnowledgeInput({ env, token, chatId, uctx, userText, adminId: userId })) {
      return;
    }
  }

  // ---------- 群规引导式输入（编辑 / 追加群规）----------
  if (canManageGuard && (await isGuardGuideActive(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await cancelGuardGuide({ env, token, chatId });
        return;
      }
    } else if (await handleGuardGuideInput({ env, token, chatId, userText, uctx, adminId: userId })) {
      return;
    }
  }

  // ---------- 👑 管理员与权限：添加管理员的引导式输入（私聊与群聊都支持）----------
  if (can(role, "manage_admins") && (await isAdminGuideActive(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await cancelAdminGuide({ env, token, chatId });
        return;
      }
    } else if (await handleAdminGuideInput({ env, token, chatId, userText, adminId: userId })) {
      return;
    }
  }

  // ---------- 商城下单备注输入（私聊，任何用户）----------
  // ---------- 自定义群组标签：选群后填标签（私聊，任何用户）----------
  if (!isGroupCtx && (await getTagSession(env, chatId))) {
    if (isCommandLike) {
      if (/^\/(cancel|取消)$/i.test(command)) {
        await handleTagCancel({ token, env, chatId });
        return;
      }
    } else if (await handleTagInput({ token, env, chatId, uctx, userText })) {
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
    await sendAutoDelete(token, chatId, ERR.UNKNOWN_CMD, null, isGroupCtx, ctx, {
      kind: "cmd", env, sceneKey
    });
    return;
  }

  // ---------- 非指令 → AI 对话 ----------
  // 主动预警：命中关键词只私聊提醒管理员，不影响用户正常使用。
  // 管理员 / owner 的发言同样要过（群规对谁都一样）。
  if (isGroupCtx) {
    try {
      await handleKeywordAlert({
        env, token, chatId, uctx, message, rawText: originalText, myId, ctx
      });
    } catch (e) {
      logError("关键词预警失败：", e);
    }
  }

  if (!(await isFeatureEnabled(env, sceneKey, "ai"))) {
    await sendAutoDelete(
      token, chatId,
      `⚠️ 本场景已关闭「${featureLabel("ai")}」，如需使用请联系管理员。`,
      null, isGroupCtx, ctx, { kind: "cmd", env, sceneKey }
    );
    return;
  }

  return handleAIRequest({
    env, ctx, token, chatId, userKey, sceneKey, isGroupCtx, isMaster,
    firstName, userText, userConfig
  });
}
