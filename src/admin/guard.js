// ==========================================
// 🛡️ 群规执法（管理端交互）
//
// 入口有两个：
//   1. 自然语言：群里 @机器人 说「封禁 @某人 发广告」→ handleGuardRequest
//   2. 显式指令：/ban /kick /mute（群里带理由）→ 命令里直接调用 requestPunishment
//
// 两者都会：
//   校验权限 → 校验理由是否对得上群规 → 落一条 pending 记录 → 弹确认卡片
// 管理员点「✅ 确认执行」后才真正落地（卡片上还能一键改成禁言 / 踢出等）。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { isFeatureEnabled } from "../services/features.js";
import {
  ACTIONS, formatDuration, getGroupGuard, getBotGroupRights, isGroupAdmin,
  parsePunishmentRequest, validateReason, reasonRejectHint,
  createPendingPunishment, getPunishment, updatePunishmentStatus,
  executePunishment, buildPunishmentNotice
} from "../services/guard.js";
import { logAdminAction } from "../services/admin-log.js";
import { logError } from "../core/logger.js";

/** 确认卡片按钮里的动作（按顺序排，两列网格） */
const SWITCH_ACTIONS = ["mute", "kick", "bot_ban", "group_ban"];

/** 确认卡片键盘（纯函数，便于排版测试） */
export function getGuardCardKeyboard(record) {
  const id = record.id;
  const buttons = [
    { text: "✅ 确认执行", callback_data: `guard_go_${id}` },
    { text: "❌ 取消", callback_data: `guard_no_${id}` }
  ];
  const rows = grid(buttons);

  const switchButtons = SWITCH_ACTIONS
    .filter((action) => action !== record.action)
    .map((action) => ({
      text: `改为${ACTIONS[action].short}`,
      callback_data: `guard_set_${id}_${action}`
    }));
  rows.push(...grid(switchButtons));
  return { inline_keyboard: rows };
}

/** 渲染确认卡片文案 */
export function buildGuardCardText(record, extra = "") {
  const action = ACTIONS[record.action] || { label: record.action };
  let text = `🛡️ <b>群规执法 · 待确认</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `👤 <b>对象：</b> ${escapeHtml(record.user_label || record.user_id)}\n`;
  text += `🆔 <b>用户 ID：</b> <code>${escapeHtml(record.user_id)}</code>\n`;
  text += `⚖️ <b>处置：</b> ${action.label}`;
  if (record.action === "mute") text += `（${formatDuration(record.duration_min)}）`;
  text += `\n`;
  text += `📌 <b>理由：</b> ${escapeHtml(record.reason || "（未说明）")}\n`;
  if (record.matched_rule) text += `📜 <b>依据：</b> ${escapeHtml(record.matched_rule)}\n`;
  text += `\n确认后立即执行；也可以直接点下面的按钮换一种处置方式。`;
  if (extra) text += `\n\n${extra}`;
  return text;
}

/**
 * 创建待确认的处置并弹出确认卡片。
 * 调用前必须已经校验过权限与理由。
 */
export async function requestPunishment({
  env, token, chatId, userId, userLabel, action, reason, matchedRule = "",
  durationMin = 0, operatorId = ""
}) {
  const record = await createPendingPunishment(env, {
    chatId, userId, userLabel, action, reason, matchedRule, durationMin, operatorId
  });
  if (!record) {
    await sendMessage(token, chatId, "❌ 创建处置记录失败，请稍后重试。");
    return null;
  }

  const full = await getPunishment(env, record.id);
  const text = buildGuardCardText(full);
  const keyboard = getGuardCardKeyboard(full);
  await sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
  return full;
}

/**
 * 自然语言执法入口（群里 @机器人 说话时调用）。
 * @returns {Promise<boolean>} 是否已处理这条消息
 */
export async function handleGuardRequest({
  env, token, chatId, uctx, message, rawText, myId, isGroupCtx
}) {
  if (!isGroupCtx || !env.DB) return false;
  if (!(await isFeatureEnabled(env, uctx.sceneKey, "guard"))) return false;

  const settings = await getGroupGuard(env, chatId);
  if (Number(settings.enabled) !== 1) return false;

  const operatorId = uctx.userId;
  // 权限：机器人管理员 或 本群管理员
  const allowed = (myId && operatorId === String(myId)) || (await isGroupAdmin(token, chatId, operatorId));
  if (!allowed) {
    await sendMessage(
      token, chatId,
      "⚠️ 只有<b>本群管理员</b>或机器人管理员可以下达处置指令。",
      "HTML"
    );
    return true;
  }

  const parsed = await parsePunishmentRequest({
    env, text: rawText, message, botUsername: env.BOT_USERNAME,
    defaultAction: settings.default_action === "bot" ? "bot_ban" : settings.default_action,
    defaultMuteMinutes: Number(settings.default_mute_minutes) || 60
  });

  if (!parsed.ok) {
    await sendMessage(token, chatId, `⚠️ ${parsed.error}`, "HTML");
    return true;
  }

  return sendOrReject({ env, token, chatId, settings, parsed, operatorId });
}

/**
 * 校验理由 → 通过就弹确认卡片，不通过就给出可用违规类型。
 * @returns {Promise<boolean>} 恒为 true（已消费这条消息）
 */
async function sendOrReject({ env, token, chatId, settings, parsed, operatorId }) {
  const checked = await validateReason({
    env,
    reason: parsed.reason,
    rules: settings.rules,
    chatId
  });

  if (!checked.ok) {
    await createPendingPunishment(env, {
      chatId, userId: parsed.userId, userLabel: parsed.userLabel,
      action: parsed.action, reason: parsed.reason, durationMin: parsed.durationMin,
      operatorId, detail: `理由不成立：${checked.error}`
    }).then((row) => row && updatePunishmentStatus(env, row.id, "rejected", checked.error));

    await sendMessage(
      token, chatId,
      `⚠️ <b>未执行</b>：${escapeHtml(checked.error)}\n\n${reasonRejectHint(settings.rules)}`,
      "HTML"
    );
    return true;
  }

  const record = await requestPunishment({
    env, token, chatId,
    userId: parsed.userId,
    userLabel: parsed.userLabel,
    action: parsed.action,
    reason: parsed.reason,
    matchedRule: `${checked.matchedRule}（${checked.how}）`,
    durationMin: parsed.durationMin,
    operatorId
  });

  if (record) {
    await logAdminAction(env, {
      adminId: operatorId, chatId, action: "guard_request",
      detail: `#${record.id} ${parsed.action} ${parsed.userLabel || parsed.userId}：${parsed.reason}`
    });
  }
  return true;
}

/**
 * 显式指令入口（/ban /kick /mute）：参数已经解析好，这里只做校验与确认。
 * @returns {Promise<void>}
 */
export async function requestPunishmentFromCommand({
  env, token, chatId, uctx, userId, userLabel, action, reason, durationMin, operatorId, myId
}) {
  const settings = await getGroupGuard(env, chatId);
  const reasonText = String(reason || "").trim();

  const checked = await validateReason({ env, reason: reasonText, rules: settings.rules, chatId });
  if (!checked.ok) {
    const row = await createPendingPunishment(env, {
      chatId, userId, userLabel, action, reason: reasonText, durationMin, operatorId,
      detail: `理由不成立：${checked.error}`
    });
    if (row) await updatePunishmentStatus(env, row.id, "rejected", checked.error);

    await sendMessage(
      token, chatId,
      `⚠️ <b>未执行</b>：${escapeHtml(checked.error)}\n\n${reasonRejectHint(settings.rules)}`,
      "HTML"
    );
    return;
  }

  const record = await requestPunishment({
    env, token, chatId, userId, userLabel, action, reason: reasonText,
    matchedRule: `${checked.matchedRule}（${checked.how}）`,
    durationMin, operatorId
  });

  if (record) {
    await logAdminAction(env, {
      adminId: operatorId, chatId, action: "guard_request",
      detail: `#${record.id} ${action} ${userLabel || userId}：${reasonText}`
    });
  }
}

/**
 * 确认卡片回调：guard_go_<id> / guard_no_<id> / guard_set_<id>_<action>
 */
export async function handleGuardCallback({ env, ctx, token, chatId, callback, data, myId, msgId }) {
  if (!env.DB) return;

  const parts = String(data).split("_");
  const kind = parts[1];        // go / no / set
  const id = Number.parseInt(parts[2], 10);
  const action = parts[3] || null;
  if (!Number.isInteger(id)) {
    await answerCallback(token, callback.id, "⚠️ 参数无效", true);
    return;
  }

  const record = await getPunishment(env, id);
  if (!record) {
    await answerCallback(token, callback.id, "❌ 记录不存在", true);
    return;
  }
  if (record.status !== "pending") {
    await answerCallback(token, callback.id, `⚠️ 该处置已${record.status === "done" ? "执行" : "结束"}`, true);
    return;
  }

  // 只有发起人本人或机器人管理员能确认
  const operatorId = String(callback.from?.id || "");
  const allowed = operatorId === String(record.operator_id) || (myId && operatorId === String(myId));
  if (!allowed) {
    await answerCallback(token, callback.id, "❌ 只有发起该处置的管理员才能确认", true);
    return;
  }

  // ---------- 换个处置方式 ----------
  if (kind === "set" && action && ACTIONS[action]) {
    // 切换成「禁言」时补上本群默认时长，避免变成「永久禁言」
    let durationMin = Number(record.duration_min) || 0;
    if (action === "mute" && durationMin <= 0) {
      const settings = await getGroupGuard(env, chatId);
      durationMin = Number(settings.default_mute_minutes) || 60;
    }
    await env.DB.prepare(
      "UPDATE group_punishments SET action = ?, duration_min = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(action, durationMin, id).run();
    const updated = await getPunishment(env, id);
    await answerCallback(token, callback.id, `已改为${ACTIONS[action].short}`);
    await editMessageText(token, chatId, msgId, buildGuardCardText(updated), getGuardCardKeyboard(updated), "HTML");
    return;
  }

  // ---------- 取消 ----------
  if (kind === "no") {
    await updatePunishmentStatus(env, id, "cancelled", "管理员取消");
    await answerCallback(token, callback.id, "已取消");
    await editMessageText(
      token, chatId, msgId,
      `🚫 <b>已取消该处置</b>\n${LAYOUT.DIVIDER}\n👤 ${escapeHtml(record.user_label || record.user_id)}\n📌 理由：${escapeHtml(record.reason || "")}`,
      { inline_keyboard: [] }, "HTML"
    );
    await logAdminAction(env, {
      adminId: operatorId, chatId, action: "guard_cancel", detail: `#${id}`
    });
    return;
  }

  if (kind !== "go") {
    await answerCallback(token, callback.id, "⚠️ 未知操作", true);
    return;
  }

  // ---------- 真正执行 ----------
  const needsTelegram = record.action !== "bot_ban";
  if (needsTelegram) {
    const rights = await getBotGroupRights(token, chatId);
    if (!rights.canRestrict) {
      await answerCallback(token, callback.id, "❌ 机器人没有群管理权限", true);
      await editMessageText(
        token, chatId, msgId,
        buildGuardCardText(record,
          "⚠️ <b>无法执行</b>：机器人不是本群管理员，或缺少「删除消息 / 封禁用户」权限。\n" +
          "请把机器人设为管理员后重试，或改选「机器人封禁」（不需要群管理权限）。"),
        getGuardCardKeyboard(record), "HTML"
      );
      return;
    }
  }

  const result = await executePunishment({
    env, token, record, action: record.action, durationMin: record.duration_min
  });

  if (!result.ok) {
    await updatePunishmentStatus(env, id, "failed", result.error || "执行失败");
    await answerCallback(token, callback.id, `❌ 执行失败：${String(result.error || "").slice(0, 120)}`, true);
    await editMessageText(
      token, chatId, msgId,
      buildGuardCardText(record, `⚠️ <b>执行失败：</b>${escapeHtml(result.error || "")}`),
      { inline_keyboard: [] }, "HTML"
    );
    return;
  }

  await updatePunishmentStatus(env, id, "done", result.detail || "");
  await env.DB.prepare(
    "UPDATE group_punishments SET until_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(Number(result.untilAt) || 0, id).run();

  await answerCallback(token, callback.id, `✅ ${result.detail || "已执行"}`);

  const done = await getPunishment(env, id);
  await editMessageText(
    token, chatId, msgId,
    `✅ <b>已执行</b>\n${LAYOUT.DIVIDER}\n` +
    `👤 ${escapeHtml(done.user_label || done.user_id)}\n` +
    `⚖️ ${ACTIONS[done.action]?.short || done.action}` +
    (done.action === "mute" ? `（${formatDuration(done.duration_min)}）` : "") + `\n` +
    `📌 ${escapeHtml(done.reason || "")}`,
    { inline_keyboard: [] }, "HTML"
  );

  // 群内公告 + 私聊通知当事人（通知失败不影响结果）
  try {
    await sendMessage(token, chatId, buildPunishmentNotice({
      record: done, action: done.action, durationMin: done.duration_min,
      untilAt: Number(done.until_at) || 0, byWhom: "管理员"
    }), "HTML");
  } catch (e) {
    logError("发送处置公告失败：", e);
  }

  try {
    await sendMessage(
      token, done.user_id,
      `🛡️ 你在群 <code>${escapeHtml(chatId)}</code> 被管理员处置：${ACTIONS[done.action]?.short || done.action}\n` +
      `📌 理由：${escapeHtml(done.reason || "")}`,
      "HTML"
    );
  } catch { /* 用户没私聊过机器人时会失败，忽略 */ }

  await logAdminAction(env, {
    adminId: operatorId, chatId, action: "guard_execute",
    detail: `#${id} ${done.action} ${done.user_label || done.user_id}（${result.detail || ""}）`
  });
}
