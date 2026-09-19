// ==========================================
// 👋 入群欢迎与人机验证（v3.9.0）
//
// 新成员进群时：
//   1. 发一条欢迎语（模板支持 {name} / {group}）
//   2. 若本群开了「验证」：先把新成员**限制发言**，再给一个「✅ 我已阅读群规」按钮；
//      点按钮 → 原子把记录从 pending 改掉 → 解除限制 → 回执。
//   3. 超时没点 → 由 cron（每 2 分钟，及时型）按本群配置踢出或仅解除限制。
//
// 为什么用 message.new_chat_members 而不是 chat_member 更新：
//   `chat_member` 属于默认**不推送**的更新类型，要收它就必须重设 webhook 的
//   allowed_updates（自愈巡检、部署文档、老部署全都要跟着改）。
//   new_chat_members 是普通 message 更新的一部分，默认就能收到，代价只是
//   看不到「成员自己退出」这类事件 —— 对「欢迎 + 验证」来说完全够用。
//
// 安全约定（见 AGENTS.md）：
//   • 状态流转一律用**带条件的原子 UPDATE** 做唯一凭据，连点 / Telegram 重推都不会重复执行
//   • 机器人自己、群主 / 管理员都不做限制（Telegram 会拒绝，而且没必要）
//   • 新人点按钮是「用户自助」，不是 AI 执法，也不走群规的理由校验
//   • 配置是**群级**的（scene_settings 的 group:<群ID>），不要用成员级 sceneKey
// ==========================================

import {
  sendMessageGetId, editMessageReplyMarkup, answerCallback,
  restrictChatMember, banChatMember, unbanChatMember, getChatMember
} from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { ADMIN_CALLBACK, WELCOME } from "../config/constants.js";
import { buildGroupScopeKey } from "../core/context.js";
import { isFeatureEnabled } from "./features.js";
import { logError, logWarn } from "../core/logger.js";

const PREFIX = "welcome.";

/** 群级配置作用域（欢迎语 / 验证开关等都属于整个群） */
export function welcomeScopeKey(chatId) {
  return buildGroupScopeKey(chatId);
}

/**
 * 读取本群的欢迎配置。
 * 读不到 / 字段缺失时都回落到内置默认，绝不因为一条脏数据让入群流程报错。
 * @returns {Promise<{text:string, verify:boolean, timeoutMin:number, kick:boolean}>}
 */
export async function getWelcomeConfig(env, chatId) {
  const config = {
    text: "",
    verify: false,
    timeoutMin: WELCOME.DEFAULT_TIMEOUT_MIN,
    kick: true
  };
  if (!env?.DB || !chatId) return config;

  try {
    const { results } = await env.DB.prepare(
      "SELECT name, value FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
    ).bind(welcomeScopeKey(chatId), `${PREFIX}%`).all();

    for (const row of results || []) {
      const name = String(row.name || "").slice(PREFIX.length);
      const value = String(row.value ?? "");
      if (name === "text") config.text = value;
      else if (name === "verify") config.verify = value === "on";
      else if (name === "kick") config.kick = value === "on";
      else if (name === "timeout_min") {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n > 0 && n <= 1440) config.timeoutMin = n;
      }
    }
  } catch (e) {
    logError("读取入群欢迎配置失败（按默认值处理）：", e);
  }
  return config;
}

/** 写入单个群级配置项 */
export async function setWelcomeConfig(env, chatId, name, value) {
  if (!env?.DB || !chatId || !name) return false;
  await env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(welcomeScopeKey(chatId), `${PREFIX}${name}`, String(value)).run();
  return true;
}

/** 清除单个群级配置项（恢复内置默认） */
export async function clearWelcomeConfig(env, chatId, name) {
  if (!env?.DB || !chatId || !name) return false;
  await env.DB.prepare("DELETE FROM scene_settings WHERE scene_key = ? AND name = ?")
    .bind(welcomeScopeKey(chatId), `${PREFIX}${name}`).run();
  return true;
}

/** 本群是否开启了「入群欢迎与验证」功能开关 */
export async function isWelcomeEnabled(env, chatId) {
  return isFeatureEnabled(env, welcomeScopeKey(chatId), "welcome");
}

// ==========================================
// 文案
// ==========================================

/** 新成员的显示名（优先「名 姓」，退到用户名 / 通用称呼） */
export function memberDisplayName(member) {
  const name = [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim();
  return name || String(member?.username || "").trim() || "新朋友";
}

/**
 * 渲染欢迎语。模板是管理员写的纯文本，渲染结果整体 escape 后再拼 HTML ——
 * 成员名字是用户可控的，绝不能直接进 HTML 消息。
 */
export function welcomeMessageText(config, { name = "", group = "", restricted = false } = {}) {
  const template = String(config?.text || "").trim() || WELCOME.DEFAULT_TEXT;
  const body = template
    .replace(/\{name\}/g, name || "新朋友")
    .replace(/\{group\}/g, group || "本群");

  let text = escapeHtml(body);
  if (restricted) {
    const timeout = Number(config?.timeoutMin) || WELCOME.DEFAULT_TIMEOUT_MIN;
    text +=
      `\n\n🔒 <b>完成验证后即可发言</b>\n` +
      `请点击下面的「✅ 我已阅读群规」按钮。\n` +
      `⏱ ${timeout} 分钟内未验证${config?.kick ? "会被移出群聊" : "仍不能发言"}。`;
  }
  return text;
}

// ==========================================
// 入群处理
// ==========================================

/**
 * 处理一批新成员。
 * @param {object} params
 * @param {Array} params.members Telegram 的 message.new_chat_members 数组
 * @returns {Promise<{welcomed:number, verifying:number}>}
 */
export async function handleNewMembers({
  env, token, chatId, chatTitle = "", members = [], enabled = null
}) {
  const result = { welcomed: 0, verifying: 0 };
  if (!env?.DB || !token || !chatId) return result;

  // 机器人自己（以及别的机器人）不进流程：不能限制自己，也没必要欢迎
  const list = (members || []).filter((m) => m && m.id && !m.is_bot);
  if (list.length === 0) return result;

  const on = enabled === null ? await isWelcomeEnabled(env, chatId) : Boolean(enabled);
  if (!on) return result;

  const config = await getWelcomeConfig(env, chatId);
  const nowSec = Math.floor(Date.now() / 1000);

  for (const member of list) {
    const userId = String(member.id);
    const name = memberDisplayName(member);

    // 只有真正把权限收紧了才要求点按钮：没有「封禁用户」权限时降级为「只欢迎」
    const restricted = config.verify ? await restrictForVerification(token, chatId, userId) : false;

    const text = welcomeMessageText(config, { name, group: chatTitle, restricted });
    const keyboard = restricted
      ? { inline_keyboard: [[{ text: "✅ 我已阅读群规", callback_data: ADMIN_CALLBACK.JOIN_VERIFY_OK }]] }
      : null;

    let messageId = 0;
    try {
      messageId = Number(await sendMessageGetId(token, chatId, text, "HTML", keyboard)) || 0;
    } catch (e) {
      logError("发送入群欢迎失败：", e);
    }
    result.welcomed++;

    if (!restricted) continue;

    const untilAt = nowSec + config.timeoutMin * 60;
    try {
      // 同一人重复入群（被踢后又回来）时重置为待验证：重新走一遍流程是符合预期的
      await env.DB.prepare(`
        INSERT INTO join_verifications (chat_id, user_id, status, verify_msg_id, joined_at, until_at, updated_at)
        VALUES (?, ?, 'pending', ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          status = 'pending', verify_msg_id = EXCLUDED.verify_msg_id,
          joined_at = CURRENT_TIMESTAMP, until_at = EXCLUDED.until_at, updated_at = CURRENT_TIMESTAMP
      `).bind(chatId, userId, messageId, untilAt).run();
      result.verifying++;
    } catch (e) {
      logError("写入入群验证记录失败（该成员仍被限制发言，请留意）：", e);
    }
  }

  return result;
}

/**
 * 收紧新成员权限。
 * 群主 / 管理员不能被限制，Telegram 会直接报错，所以先看一次成员状态。
 * @returns {Promise<boolean>} 是否真的限制成功
 */
export async function restrictForVerification(token, chatId, userId) {
  try {
    const info = await getChatMember(token, chatId, userId);
    const status = String(info?.result?.status || "");
    if (status && status !== "member" && status !== "restricted") return false;
  } catch (e) {
    logWarn("读取新成员状态失败，跳过限制：", e?.message || e);
    return false;
  }

  try {
    const res = await restrictChatMember(token, chatId, userId, { mute: true });
    if (res && res.ok === false) {
      logWarn("限制新成员发言被 Telegram 拒绝（机器人缺少「封禁用户」权限？）：",
        res.description || res?.error?.description || "");
      return false;
    }
    return true;
  } catch (e) {
    logWarn("限制新成员发言失败：", e?.message || e);
    return false;
  }
}

/** 解除限制（验证通过 / 选择了「超时不踢出」） */
export async function liftRestriction(token, chatId, userId) {
  try {
    const res = await restrictChatMember(token, chatId, userId, { mute: false });
    return !(res && res.ok === false);
  } catch (e) {
    logError("解除成员限制失败：", e);
    return false;
  }
}

// ==========================================
// 验证按钮
// ==========================================

/**
 * 处理「✅ 我已阅读群规」按钮。
 * 任何成员都能点，但只能通过**自己**的验证（user_id 取自点击者）。
 */
export async function handleJoinVerifyCallback({ env, token, callback, chatId, userId, messageId }) {
  if (!env?.DB) {
    await answerCallback(token, callback.id, "❌ 未绑定数据库", true);
    return;
  }

  // 原子占用：pending → passed，只有改到一行的那一次才有权解除限制
  const claim = await env.DB.prepare(
    `UPDATE join_verifications SET status = 'passed', updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ? AND user_id = ? AND status = 'pending'`
  ).bind(String(chatId), String(userId)).run();

  if ((Number(claim?.meta?.changes) || 0) === 0) {
    await answerCallback(token, callback.id, "这次验证已经处理过了", true);
    return;
  }

  const lifted = await liftRestriction(token, chatId, userId);
  await answerCallback(
    token, callback.id,
    lifted ? "✅ 验证通过，欢迎加入！" : "✅ 已验证；解除限制失败，请联系管理员",
    !lifted
  );

  // 收掉按钮，但保留欢迎语正文
  if (messageId) {
    try {
      await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] });
    } catch (e) {
      logWarn("收起验证按钮失败（不影响验证结果）：", e?.message || e);
    }
  }
}

// ==========================================
// 超时处理（cron）
// ==========================================

/** 把超时未验证的成员移出群聊（先封再解 = 「踢出但允许以后重新加入」） */
async function kickMember(token, chatId, userId) {
  try {
    const banned = await banChatMember(token, chatId, userId);
    if (banned && banned.ok === false) {
      logWarn("移出未验证成员失败：", banned.description || banned?.error?.description || "");
      return false;
    }
    await unbanChatMember(token, chatId, userId, false);
    return true;
  } catch (e) {
    logError("移出未验证成员失败：", e);
    return false;
  }
}

/**
 * 处理超时未验证的记录（**及时型**：挂在每 2 分钟的 cron 上）。
 * 每条都先原子占用再动手，避免与「用户刚好点按钮」并发时两边都执行。
 * @returns {Promise<{checked:number, kicked:number, released:number, failed:number}>}
 */
export async function processJoinVerifications(env, token, { limit = WELCOME.PROCESS_LIMIT } = {}) {
  const result = { checked: 0, kicked: 0, released: 0, failed: 0 };
  if (!env?.DB || !token) return result;

  const nowSec = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    `SELECT chat_id, user_id FROM join_verifications
      WHERE status = 'pending' AND until_at <= ?
      ORDER BY until_at ASC LIMIT ?`
  ).bind(nowSec, Math.max(1, Math.floor(limit) || WELCOME.PROCESS_LIMIT)).all();

  for (const row of results || []) {
    const chatId = String(row.chat_id);
    const userId = String(row.user_id);

    const claim = await env.DB.prepare(
      `UPDATE join_verifications SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ? AND user_id = ? AND status = 'pending' AND until_at <= ?`
    ).bind(chatId, userId, nowSec).run();
    if ((Number(claim?.meta?.changes) || 0) === 0) continue;

    result.checked++;
    const config = await getWelcomeConfig(env, chatId);

    if (config.kick) {
      if (await kickMember(token, chatId, userId)) result.kicked++;
      else result.failed++;
    } else {
      // 不踢也必须解除限制，否则等于永久禁言
      if (await liftRestriction(token, chatId, userId)) result.released++;
      else result.failed++;
    }
  }

  return result;
}
