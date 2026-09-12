// ==========================================
// 🛡️ 处置指令：/ban /groupban /kick /mute /unban /unmute /rules /setrules
//
// 两种使用场景：
//   • 私聊：/ban <用户ID> —— 直接把人加进「机器人封禁名单」（机器人不再服务他）
//   • 群里：/ban|/kick|/mute|/groupban <@用户|用户ID|回复对方消息> <理由>
//           → 先按群规校验理由，再弹确认卡片，确认后才执行
//
// 自然语言同样支持（不用记指令）：群里 @机器人 说「封禁 @某人 发广告」即可。
// 解除类（/unban /unmute）不需要理由与确认，直接执行。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { escapeHtml } from "../../utils/html.js";
import { banUserById, unbanUserById } from "../../services/users.js";
import { logAdminAction } from "../../services/admin-log.js";
import {
  ACTIONS, formatDuration, getGroupGuard, setGroupGuard,
  parsePunishmentRequest, executePunishment, VIOLATION_RULES
} from "../../services/guard.js";
import { requestPunishmentFromCommand } from "../../admin/guard.js";

const USAGE_BAN =
  "🚫 <b>机器人封禁</b>（该用户在私聊与所有群都不再被服务）\n-------------------------\n" +
  "• 私聊：<code>/ban &lt;用户ID&gt; [理由]</code>\n" +
  "• 群里：<code>/ban @某人 理由</code>（或回复对方消息后发 /ban 理由）\n\n" +
  "群里执行前会校验理由是否符合群规，并弹出确认卡片。";

const USAGE_KICK =
  "👢 <b>踢出群组</b>（对方可重新加入）\n-------------------------\n" +
  "用法：<code>/kick @某人 理由</code>\n" +
  "也可以回复对方的消息后直接发送 <code>/kick 理由</code>。";

const USAGE_MUTE =
  "🔇 <b>群内禁言</b>\n-------------------------\n" +
  "用法：<code>/mute @某人 [时长] 理由</code>\n" +
  "时长支持：<code>30分钟</code> / <code>2小时</code> / <code>1天</code> / <code>永久</code>（不写用本群默认值）\n" +
  "例：<code>/mute @某人 2小时 刷屏</code>";

const USAGE_UNBAN =
  "✅ <b>解除封禁</b>\n-------------------------\n" +
  "• 私聊：<code>/unban &lt;用户ID&gt;</code>\n" +
  "• 群里：<code>/unban @某人</code>（同时解除机器人封禁与群封禁）";

const USAGE_UNMUTE =
  "🔊 <b>解除禁言</b>\n-------------------------\n" +
  "用法：<code>/unmute @某人</code>（或回复对方消息后发送）";

/** 去掉指令名，拿到参数 */
function stripCommand(rawText, name) {
  return String(rawText || "").replace(new RegExp(`^${name}(@\\w+)?`, "i"), "").trim();
}

/** 参数里的数字用户 ID */
function parseNumericId(text) {
  const m = /(\d{5,})/.exec(String(text || ""));
  return m ? m[1] : "";
}

/**
 * 群内处置指令的公共实现：解析目标与理由 → 交给群规执法（校验 + 确认卡片）。
 * 理由不成立时不会执行，并提示可用的违规类型。
 */
async function groupPunishCommand({ env, ctx, token, chatId, uctx, message, originalText, rawText, myId, action, usage }) {
  const settings = await getGroupGuard(env, chatId);

  const parsed = await parsePunishmentRequest({
    env,
    text: originalText || rawText || "",
    message,
    botUsername: env.BOT_USERNAME,
    forcedAction: action,
    defaultMuteMinutes: Number(settings.default_mute_minutes) || 60
  });

  if (!parsed.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${parsed.error}\n\n${usage}`, "HTML", true, ctx);
    return;
  }

  if (myId && String(parsed.userId) === String(myId)) {
    await sendAutoDelete(token, chatId, "⚠️ 不能处置管理员自己。", null, true, ctx);
    return;
  }

  await requestPunishmentFromCommand({
    env, token, chatId, uctx,
    userId: parsed.userId,
    userLabel: parsed.userLabel,
    action,
    reason: parsed.reason,
    durationMin: parsed.durationMin,
    operatorId: myId
  });
}

// ==========================================
// 封禁类
// ==========================================

/** /ban：私聊里直接封禁；群里走「理由校验 + 确认卡片」 */
export async function cmdBan({ env, ctx, token, chatId, isGroupCtx, rawText, myId, uctx, message, originalText }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  if (isGroupCtx) {
    return groupPunishCommand({
      env, ctx, token, chatId, uctx, message, originalText, rawText, myId,
      action: "bot_ban", usage: USAGE_BAN
    });
  }

  const body = stripCommand(rawText, "/ban");
  if (!body) {
    await sendAutoDelete(token, chatId, USAGE_BAN, "HTML", isGroupCtx, ctx);
    return;
  }

  const [first, ...rest] = body.split(/\s+/).filter(Boolean);
  const reason = rest.join(" ").slice(0, 100);

  if (myId && String(first) === String(myId)) {
    await sendAutoDelete(token, chatId, "⚠️ 不能封禁管理员自己。", null, isGroupCtx, ctx);
    return;
  }

  const res = await banUserById(env, first);
  if (!res.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${res.error}\n\n${USAGE_BAN}`, "HTML", isGroupCtx, ctx);
    return;
  }

  await logAdminAction(env, {
    adminId: myId, chatId, action: "user_block",
    detail: `${res.userKey}${reason ? ` 原因：${reason}` : ""}${res.existed ? "" : "（新建档案）"}`
  });

  await sendAutoDelete(
    token, chatId,
    `🚫 <b>已加入封禁名单</b>\n-------------------------\n` +
    `🆔 <code>${escapeHtml(first)}</code>\n` +
    `📝 理由：${reason ? escapeHtml(reason) : "（未填写）"}\n\n` +
    `该用户在私聊与所有群都将停止服务；可用 <code>/unban ${escapeHtml(first)}</code> 解封。`,
    "HTML", isGroupCtx, ctx
  );
}

/** /groupban：群内封禁（不可重新加入） */
export async function cmdGroupBan({ env, ctx, token, chatId, isGroupCtx, uctx, message, originalText, rawText, myId }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /groupban 需要在群里使用（它封禁的是群成员身份）。", null, isGroupCtx, ctx);
    return;
  }
  return groupPunishCommand({
    env, ctx, token, chatId, uctx, message, originalText, rawText, myId,
    action: "group_ban",
    usage: "🔨 <b>群内封禁</b>\n用法：<code>/groupban @某人 理由</code>（对方无法重新加入）"
  });
}

/** /kick：踢出群组（可重新加入） */
export async function cmdKick({ env, ctx, token, chatId, isGroupCtx, uctx, message, originalText, rawText, myId }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /kick 需要在群里使用。", null, isGroupCtx, ctx);
    return;
  }
  return groupPunishCommand({
    env, ctx, token, chatId, uctx, message, originalText, rawText, myId,
    action: "kick", usage: USAGE_KICK
  });
}

/** /mute：群内禁言（支持时长） */
export async function cmdMute({ env, ctx, token, chatId, isGroupCtx, uctx, message, originalText, rawText, myId }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /mute 需要在群里使用。", null, isGroupCtx, ctx);
    return;
  }
  return groupPunishCommand({
    env, ctx, token, chatId, uctx, message, originalText, rawText, myId,
    action: "mute", usage: USAGE_MUTE
  });
}

// ==========================================
// 解除类（直接执行）
// ==========================================

/** /unban：解除机器人封禁 + 群封禁 */
export async function cmdUnban({ env, ctx, token, chatId, isGroupCtx, rawText, myId, uctx, message, originalText }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  if (isGroupCtx) {
    const parsed = await parsePunishmentRequest({
      env, text: originalText || rawText || "", message,
      botUsername: env.BOT_USERNAME, forcedAction: "unban"
    });
    if (!parsed.ok) {
      await sendAutoDelete(token, chatId, `⚠️ ${parsed.error}\n\n${USAGE_UNBAN}`, "HTML", true, ctx);
      return;
    }

    const result = await executePunishment({
      env, token,
      record: { chat_id: chatId, user_id: parsed.userId, user_label: parsed.userLabel },
      action: "unban"
    });
    await logAdminAction(env, {
      adminId: myId, chatId, action: "user_unblock",
      detail: `${parsed.userLabel || parsed.userId}（群内解封：${result.ok ? "成功" : result.error}）`
    });
    await sendAutoDelete(
      token, chatId,
      result.ok
        ? `✅ 已解除 <b>${escapeHtml(parsed.userLabel || parsed.userId)}</b> 的封禁（机器人 + 群）。`
        : `⚠️ 解封失败：${escapeHtml(result.error || "")}`,
      "HTML", true, ctx
    );
    return;
  }

  const targetId = parseNumericId(stripCommand(rawText, "/unban"));
  if (!targetId) {
    await sendAutoDelete(token, chatId, USAGE_UNBAN, "HTML", isGroupCtx, ctx);
    return;
  }

  const res = await unbanUserById(env, targetId);
  if (!res.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${res.error}\n\n${USAGE_UNBAN}`, "HTML", isGroupCtx, ctx);
    return;
  }

  await logAdminAction(env, {
    adminId: myId, chatId, action: "user_unblock", detail: `${res.userKey}（命令解封）`
  });
  await sendAutoDelete(token, chatId, `✅ 已解封 <code>${targetId}</code>。`, "HTML", isGroupCtx, ctx);
}

/** /unmute：解除群内禁言 */
export async function cmdUnmute({ env, ctx, token, chatId, isGroupCtx, uctx, message, originalText, rawText, myId }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /unmute 需要在群里使用。", null, isGroupCtx, ctx);
    return;
  }

  const parsed = await parsePunishmentRequest({
    env, text: originalText || rawText || "", message,
    botUsername: env.BOT_USERNAME, forcedAction: "unmute"
  });
  if (!parsed.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${parsed.error}\n\n${USAGE_UNMUTE}`, "HTML", true, ctx);
    return;
  }

  const result = await executePunishment({
    env, token,
    record: { chat_id: chatId, user_id: parsed.userId, user_label: parsed.userLabel },
    action: "unmute"
  });
  await logAdminAction(env, {
    adminId: myId, chatId, action: "guard_unmute",
    detail: `${parsed.userLabel || parsed.userId}（${result.ok ? "成功" : result.error}）`
  });
  await sendAutoDelete(
    token, chatId,
    result.ok
      ? `🔊 已解除 <b>${escapeHtml(parsed.userLabel || parsed.userId)}</b> 的禁言。`
      : `⚠️ 解除禁言失败：${escapeHtml(result.error || "")}`,
    "HTML", true, ctx
  );
}

// ==========================================
// 群规管理
// ==========================================

/** /rules：查看本群群规、默认处置与可识别的违规类型 */
export async function cmdRules({ env, ctx, token, chatId, isGroupCtx }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /rules 需要在群里使用（每个群一份群规）。", null, isGroupCtx, ctx);
    return;
  }

  const settings = await getGroupGuard(env, chatId);
  const defaultAction = ACTIONS[settings.default_action]?.short || settings.default_action;
  const categories = VIOLATION_RULES.map((r) => `• <b>${r.label}</b>：${r.keywords.slice(0, 5).join(" / ")}`).join("\n");

  await sendAutoDelete(
    token, chatId,
    `📜 <b>本群群规</b>\n-------------------------\n` +
    (settings.rules ? `${escapeHtml(settings.rules)}\n\n` : `<i>还没设置群规，用 <code>/setrules 群规正文</code> 添加。</i>\n\n`) +
    `⚖️ 默认处置：<b>${defaultAction}</b>${settings.default_action === "mute" ? `（${formatDuration(settings.default_mute_minutes)}）` : ""}\n` +
    `🛡️ 执法开关：${Number(settings.enabled) === 1 ? "✅ 已开启" : "🚫 已关闭"}\n\n` +
    `📌 <b>可识别的违规类型：</b>\n${categories}\n\n` +
    `用法：@我 说「封禁 @某人 发广告」，或 <code>/mute @某人 2小时 刷屏</code>`,
    "HTML", isGroupCtx, ctx
  );
}

/** /setrules <群规正文>：写入本群群规（执法时用它校验理由） */
export async function cmdSetRules({ env, ctx, token, chatId, isGroupCtx, rawText, myId }) {
  if (!env.DB) return sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
  if (!isGroupCtx) {
    await sendAutoDelete(token, chatId, "⚠️ /setrules 需要在群里使用。", null, isGroupCtx, ctx);
    return;
  }

  const body = stripCommand(rawText, "/setrules");
  if (!body) {
    await sendAutoDelete(token, chatId, "📜 用法：<code>/setrules 群规正文</code>", "HTML", isGroupCtx, ctx);
    return;
  }

  await setGroupGuard(env, chatId, { rules: body });
  await logAdminAction(env, {
    adminId: myId, chatId, action: "guard_set_rules", detail: body.slice(0, 100)
  });
  await sendAutoDelete(
    token, chatId,
    `✅ 群规已更新（${body.length} 字）。\n执法时会用它和理由做比对。`,
    null, isGroupCtx, ctx
  );
}
