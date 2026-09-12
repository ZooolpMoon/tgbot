// ==========================================
// 🛡️ 群规执法（管理端交互）
//
// 入口只有一个：显式指令
//   /ban /kick /groupban /mute（群里带理由）→ 命令里直接调用 requestPunishment
//   /report（成员回复违规消息后举报）→ handleReportRequest
// 不再支持「群里 @机器人 说 封禁 xxx」这种自然语言入口：
// 「封禁」「拉黑」在正常聊天里太常见，靠关键词拦截会误伤普通发言。
//
// 流程都会：
//   校验权限 → 校验理由是否对得上群规 → 落一条 pending 记录 → 弹确认卡片
// 管理员点「✅ 确认执行」后才真正落地（卡片上还能一键改成禁言 / 踢出等）。
// ==========================================

import { sendMessage, editMessageText, answerCallback } from "../telegram/api.js";
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { isFeatureEnabled } from "../services/features.js";
import { resolveAdminChatId } from "../shop/notify.js";
import {
  ACTIONS, formatDuration, getGroupGuard, getBotGroupRights, isGroupAdmin,
  validateReason, reasonRejectHint,
  createPendingPunishment, getPunishment, updatePunishmentStatus,
  executePunishment, buildPunishmentNotice,
  findAppealablePunishment, createAppeal, getAppeal, decideAppeal,
  revokePunishment, resolveAlertKeywords, scanAlertKeywords
} from "../services/guard.js";
import { logAdminAction } from "../services/admin-log.js";
import { logError } from "../core/logger.js";
import { can } from "../services/admins.js";

/** 目标会话是不是群（Telegram 的群 ID 是负数） */
function isGroupChatId(chatId) {
  return String(chatId || "").startsWith("-");
}

/**
 * 发送卡片 / 公告，并按目标会话套用「消息自动删除」设置。
 * kind：card = 带按钮的卡片（默认保留）；notice = 公告与回执（默认保留）。
 */
function deliver({ token, chatId, text, keyboard = null, ctx = null, env = null, kind = "card" }) {
  const isGroup = isGroupChatId(chatId);
  const sceneKey = isGroup ? `group:${chatId}` : null;
  return sendAutoDelete(token, chatId, text, "HTML", isGroup, ctx, {
    kind, env, sceneKey, keyboard
  });
}

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
  durationMin = 0, operatorId = "", ctx = null
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
  await deliver({ token, chatId, text, keyboard, ctx, env, kind: "card" });
  return full;
}

// ==========================================
// 成员举报 → 管理员一键处置（功能联动）
// ==========================================

/**
 * 普通成员在群里用 <code>/report 理由</code> 举报（必须先回复违规的那条消息）。
 * 流程：校验理由 → 生成待确认处置 → 把确认卡片发到**管理员私聊**，管理员一键处置。
 * 注意：记录里的 operator_id 留空，只有机器人管理员能确认卡片——
 * 举报人不应该能自己批准自己的举报。
 * @returns {Promise<boolean>} 是否已处理（false 表示调用方需要给出兜底提示）
 */
export async function handleReportRequest({ env, token, chatId, uctx, message, rawText, isMaster, ctx = null }) {
  if (!env.DB) return false;
  if (isMaster) return false;                       // 管理员走执法流程，不走举报
  if (!(await isFeatureEnabled(env, uctx.sceneKey, "guard"))) return false;

  const settings = await getGroupGuard(env, chatId);
  if (Number(settings.enabled) !== 1) return false;

  // 举报必须回复对方消息（否则不知道该处置谁）
  const replied = message?.reply_to_message?.from;
  if (!replied?.id || replied.is_bot) {
    await deliver({
      token, chatId, ctx, env, kind: "notice",
      text:
      "📣 <b>举报</b>\n" +
      "请先<b>回复违规的那条消息</b>，再发送举报指令，例如：\n" +
      "<code>/report 发广告刷屏</code>"
    });
    return true;
  }

  // 举报机器人管理员同样不受理（避免出现「管理员把自己封了」的卡片）
  if (env.MY_TELEGRAM_ID && String(replied.id) === String(env.MY_TELEGRAM_ID)) {
    await deliver({
      token, chatId, ctx, env, kind: "notice",
      text: "🛡️ 不能举报机器人管理员。"
    });
    return true;
  }

  const reason = String(rawText || "")
    .replace(new RegExp(`@${env.BOT_USERNAME || ""}`, "gi"), " ")
    .replace(/^\/report(@\w+)?/i, " ")
    .replace(/举报|投诉/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const checked = await validateReason({ env, reason, rules: settings.rules, chatId });
  if (!checked.ok) {
    await deliver({
      token, chatId, ctx, env, kind: "notice",
      text: `⚠️ 举报理由需要说清违规现象（例如：发广告、刷屏、辱骂）。\n\n${reasonRejectHint(settings.rules)}`
    });
    return true;
  }

  const userLabel = replied.username ? `@${replied.username}` : (replied.first_name || String(replied.id));
  const record = await requestPunishment({
    env, token,
    // 卡片发到管理员私聊；执行时用的是 record.chat_id（本群）
    chatId: resolveAdminChatId(env) || chatId,
    userId: String(replied.id),
    userLabel,
    action: settings.default_action === "bot" ? "bot_ban" : settings.default_action,
    reason: reason || "成员举报",
    matchedRule: `${checked.matchedRule}（${checked.how}）`,
    durationMin: Number(settings.default_mute_minutes) || 60,
    operatorId: "",
    ctx
  });

  if (record) {
    // 记录真实的群，便于执行与审计
    await env.DB.prepare(
      "UPDATE group_punishments SET chat_id = ?, detail = ? WHERE id = ?"
    ).bind(String(chatId), `由成员 ${uctx.userId} 举报`, record.id).run();
  }

  await deliver({
    token, chatId, ctx, env, kind: "notice",
    text: `📣 已把举报转给管理员处理：${escapeHtml(userLabel)} · ${escapeHtml(reason || "违规")}`
  });
  return true;
}

/**
 * 显式指令入口（/ban /kick /mute）：参数已经解析好，这里只做校验与确认。
 * @returns {Promise<void>}
 */
export async function requestPunishmentFromCommand({
  env, token, chatId, uctx, userId, userLabel, action, reason, durationMin, operatorId, ctx = null
}) {
  // 机器人管理员不能被处置：否则「谁能把限制解除」会变得不可控
  if (env.MY_TELEGRAM_ID && String(userId) === String(env.MY_TELEGRAM_ID)) {
    await sendAutoDelete(
      token, chatId, "🛡️ 不能处置机器人管理员。", "HTML", true, ctx,
      { kind: "guard", env, sceneKey: `group:${chatId}` }
    );
    return;
  }

  const settings = await getGroupGuard(env, chatId);
  const reasonText = String(reason || "").trim();

  const checked = await validateReason({ env, reason: reasonText, rules: settings.rules, chatId });
  if (!checked.ok) {
    const row = await createPendingPunishment(env, {
      chatId, userId, userLabel, action, reason: reasonText, durationMin, operatorId,
      detail: `理由不成立：${checked.error}`
    });
    if (row) await updatePunishmentStatus(env, row.id, "rejected", checked.error);

    await sendAutoDelete(
      token, chatId,
      `⚠️ <b>未执行</b>：${escapeHtml(checked.error)}\n\n${reasonRejectHint(settings.rules)}`,
      "HTML", true, ctx, { kind: "guard", env, sceneKey: `group:${chatId}` }
    );
    return;
  }

  const record = await requestPunishment({
    env, token, chatId, userId, userLabel, action, reason: reasonText,
    matchedRule: `${checked.matchedRule}（${checked.how}）`,
    durationMin, operatorId, ctx
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
export async function handleGuardCallback({ env, ctx, token, chatId, callback, data, myId, msgId, role = null }) {
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

  // 确认卡片可能发在管理员私聊（成员举报的联动流程），
  // 但真正要处置的群永远是 record.chat_id —— 权限检查与公告都必须用它。
  const groupChatId = String(record.chat_id);

  // 只有发起人本人、拥有执法权限的管理员能确认
  const operatorId = String(callback.from?.id || "");
  const allowed = operatorId === String(record.operator_id)
    || (myId && operatorId === String(myId))
    || (role && can(role, "enforce"));
  if (!allowed) {
    await answerCallback(token, callback.id, "❌ 只有发起人或有执法权限的管理员才能确认", true);
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
    const rights = await getBotGroupRights(token, groupChatId);
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
    await deliver({
      token, chatId: groupChatId, ctx, env, kind: "notice",
      text: buildPunishmentNotice({
        record: done, action: done.action, durationMin: done.duration_min,
        untilAt: Number(done.until_at) || 0, byWhom: "管理员"
      })
    });
  } catch (e) {
    logError("发送处置公告失败：", e);
  }

  try {
    await sendMessage(
      token, done.user_id,
      `🛡️ 你在群 <code>${escapeHtml(groupChatId)}</code> 被管理员处置：${ACTIONS[done.action]?.short || done.action}\n` +
      `📌 理由：${escapeHtml(done.reason || "")}`,
      "HTML"
    );
  } catch { /* 用户没私聊过机器人时会失败，忽略 */ }

  await logAdminAction(env, {
    adminId: operatorId, chatId, action: "guard_execute",
    detail: `#${id} ${done.action} ${done.user_label || done.user_id}（${result.detail || ""}）`
  });
}

// ==========================================
// 🙋 处置申诉（被处置人私聊机器人）
// ==========================================

/** 申诉卡片键盘（纯函数，便于排版测试） */
export function getAppealCardKeyboard(appealId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ 撤销处置", callback_data: `appeal_ok_${appealId}` },
        { text: "❌ 驳回申诉", callback_data: `appeal_no_${appealId}` }
      ]
    ]
  };
}

/**
 * 处理用户的申诉请求（私聊，指令 /appeal 或直接说「申诉 …」）。
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handleAppealRequest({ env, token, chatId, uctx, rawText, ctx = null }) {
  if (!env.DB) return false;

  const reason = String(rawText || "")
    .replace(/^\/appeal(@\w+)?/i, " ")
    .replace(/^申诉/, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (reason.length < 2) {
    await sendMessage(
      token, chatId,
      "🙋 <b>申诉</b>\n" +
      "用法：<code>/appeal 我认为这次处置不合理，因为…</code>\n\n" +
      "只能对<b>最近 7 天内</b>、作用在你身上的处置发起申诉。",
      "HTML"
    );
    return true;
  }

  const punishment = await findAppealablePunishment(env, uctx.userId);
  if (!punishment) {
    await sendMessage(
      token, chatId,
      "🙋 没有找到可以申诉的处置记录（只支持最近 7 天内、作用在你身上的处置）。",
      "HTML"
    );
    return true;
  }

  const created = await createAppeal(env, {
    punishmentId: punishment.id,
    chatId: punishment.chat_id,
    userId: uctx.userId,
    userLabel: punishment.user_label || uctx.userId,
    reason
  });
  if (!created.ok) {
    await sendMessage(token, chatId, `⚠️ ${created.error}`);
    return true;
  }

  // 卡片发到管理员私聊，管理员一键决定
  const adminChat = resolveAdminChatId(env) || chatId;
  const action = ACTIONS[punishment.action]?.short || punishment.action;
  await deliver({
    token, chatId: adminChat, env, ctx, kind: "card",
    keyboard: getAppealCardKeyboard(created.id),
    text:
    `🙋 <b>收到一条申诉</b>\n${LAYOUT.DIVIDER}\n` +
    `👤 <b>申诉人：</b>${escapeHtml(punishment.user_label || uctx.userId)}（<code>${escapeHtml(uctx.userId)}</code>）\n` +
    `⚖️ <b>原处置：</b>${action}（${escapeHtml(punishment.reason || "无理由")}）\n` +
    `🏠 <b>群：</b><code>${escapeHtml(punishment.chat_id)}</code>\n` +
    `💬 <b>申诉理由：</b>${escapeHtml(reason)}\n\n` +
    `点「✅ 撤销处置」会解除该用户的限制并在群里公告。`
  });

  await sendMessage(
    token, chatId,
    "✅ 申诉已提交给管理员，处理结果会私聊通知你。",
    null
  );
  return true;
}

/**
 * 申诉卡片回调：appeal_ok_<id> / appeal_no_<id>
 */
export async function handleAppealCallback({ env, token, callback, data, myId, chatId, msgId, ctx = null, role = null }) {
  if (!env.DB) return;

  const parts = String(data).split("_");
  const kind = parts[1];               // ok / no
  const appealId = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(appealId)) {
    await answerCallback(token, callback.id, "⚠️ 参数无效", true);
    return;
  }

  const appeal = await getAppeal(env, appealId);
  if (!appeal) {
    await answerCallback(token, callback.id, "❌ 申诉不存在", true);
    return;
  }
  if (appeal.status !== "pending") {
    await answerCallback(token, callback.id, "⚠️ 这条申诉已处理过了", true);
    return;
  }

  // 权限：机器人管理员，或原处置所在群的管理员
  const operatorId = String(callback.from?.id || "");
  const allowed = (myId && operatorId === String(myId))
    || (role && can(role, "enforce"))
    || (await isGroupAdmin(token, appeal.chat_id, operatorId));
  if (!allowed) {
    await answerCallback(token, callback.id, "❌ 只有管理员或有执法权限的角色能处理申诉", true);
    return;
  }

  const punishment = await getPunishment(env, appeal.punishment_id);
  const who = escapeHtml(appeal.user_label || appeal.user_id);

  if (kind === "no") {
    await decideAppeal(env, appealId, "rejected", operatorId);
    await answerCallback(token, callback.id, "已驳回");
    await editMessageText(
      token, chatId, msgId,
      `❌ <b>申诉已驳回</b>\n${LAYOUT.DIVIDER}\n👤 ${who}\n💬 ${escapeHtml(appeal.reason)}`,
      { inline_keyboard: [] }, "HTML"
    );
    try {
      await sendMessage(token, appeal.user_id, `❌ 你的申诉未通过：${escapeHtml(appeal.reason)}\n如有疑问请联系群管理员。`);
    } catch { /* 忽略 */ }
    await logAdminAction(env, {
      adminId: operatorId, chatId: appeal.chat_id, action: "guard_appeal_reject",
      detail: `申诉 #${appealId} ${appeal.user_id}`
    });
    return;
  }

  if (kind !== "ok") {
    await answerCallback(token, callback.id, "⚠️ 未知操作", true);
    return;
  }

  // 批准：撤销原处置
  let detail = "已撤销处置";
  if (punishment) {
    const result = await revokePunishment({
      env, token, record: punishment, operatorId, note: "申诉通过"
    });
    if (!result.ok) {
      await answerCallback(token, callback.id, `⚠️ ${result.error}`, true);
      return;
    }
    detail = result.detail;
  }

  await decideAppeal(env, appealId, "approved", operatorId);
  await answerCallback(token, callback.id, `✅ 申诉通过：${detail}`, true);
  await editMessageText(
    token, chatId, msgId,
    `✅ <b>申诉通过，处置已撤销</b>\n${LAYOUT.DIVIDER}\n👤 ${who}\n💬 ${escapeHtml(appeal.reason)}\n⚙️ ${escapeHtml(detail)}`,
    { inline_keyboard: [] }, "HTML"
  );

  if (punishment) {
    try {
      await deliver({
        token, chatId: punishment.chat_id, env, ctx, kind: "notice",
        text: `🙋 <b>申诉通过，处置已撤销</b>\n-------------------------\n👤 ${who}\n⚙️ ${escapeHtml(detail)}`
      });
    } catch (e) {
      logError("发送申诉结果公告失败：", e);
    }
  }
  try {
    await sendMessage(token, appeal.user_id, `✅ 你的申诉已通过，限制已解除（${escapeHtml(detail)}）。`);
  } catch { /* 忽略 */ }

  await logAdminAction(env, {
    adminId: operatorId, chatId: appeal.chat_id, action: "guard_appeal_approve",
    detail: `申诉 #${appealId} ${appeal.user_id}（${detail}）`
  });
}

// ==========================================
// 🔔 主动预警（静默提醒管理员）
// ==========================================

/**
 * 扫描一条群消息，命中预警关键词就**私聊**提醒管理员（群里不发声）。
 * 同一用户 10 分钟内只提醒一次，避免刷屏。
 * @returns {Promise<boolean>} 是否产生了预警
 */
export async function handleKeywordAlert({ env, token, chatId, uctx, message, rawText, myId, ctx = null }) {
  if (!env.DB) return false;
  if (!(await isFeatureEnabled(env, uctx.sceneKey, "guard"))) return false;

  const settings = await getGroupGuard(env, chatId);
  if (Number(settings.enabled) !== 1 || Number(settings.alert_enabled) !== 1) return false;

  const keywords = resolveAlertKeywords(settings.alert_keywords);
  const hits = scanAlertKeywords(rawText, keywords);
  if (hits.length === 0) return false;

  // 管理员自己发言不预警，也不打扰
  if (myId && String(uctx.userId) === String(myId)) return false;
  if (await isGroupAdmin(token, chatId, uctx.userId)) return false;

  // 10 分钟内同一用户只提醒一次
  const recent = await env.DB.prepare(
    `SELECT id FROM group_punishments
     WHERE chat_id = ? AND user_id = ? AND status = 'pending' AND detail LIKE '预警%'
       AND created_at >= datetime('now', '-10 minutes')
     LIMIT 1`
  ).bind(String(chatId), String(uctx.userId)).first();
  if (recent) return false;

  const name = uctx.username ? `@${uctx.username}` : (uctx.firstName || uctx.userId);
  const record = await requestPunishment({
    env, token,
    chatId: resolveAdminChatId(env) || chatId,
    userId: uctx.userId,
    userLabel: name,
    action: settings.default_action === "bot" ? "bot_ban" : settings.default_action,
    reason: `预警关键词：${hits.join("、")}`,
    matchedRule: "关键词预警（未公开处置，等你判断）",
    durationMin: Number(settings.default_mute_minutes) || 60,
    operatorId: "",
    ctx
  });

  if (record) {
    await env.DB.prepare(
      "UPDATE group_punishments SET chat_id = ?, detail = ? WHERE id = ?"
    ).bind(String(chatId), `预警命中的原话：${String(rawText).slice(0, 120)}`, record.id).run();

    await logAdminAction(env, {
      adminId: myId, chatId, action: "guard_alert",
      detail: `#${record.id} ${name}：${hits.join("、")}`
    });
  }
  return true;
}
