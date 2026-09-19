// ==========================================
// 👋 入群欢迎与验证面板（v3.9.0）
//
// 入口：群里发 /welcome
//
// 能做的事：
//   • 🔛 本群开启 / 关闭「入群欢迎与验证」（写的是**群级**功能开关）
//   • 🔒 是否要求新成员点按钮通过验证（开启后会先限制发言）
//   • ⏱ 验证超时（5 / 10 / 30 分钟轮换）
//   • 👢 超时未验证：移出群聊 / 仅解除限制
//   • ✏️ 编辑欢迎语（引导式输入，支持 {name} / {group}）
//   • ♻️ 恢复默认欢迎语
//
// 配置是**群级**的（scene_settings 的 group:<群ID>）：不要用成员级 sceneKey，
// 否则每个管理员各配一份、互相看不见。引导会话存 welcome_sessions，30 分钟过期。
//
// ⚠️ /welcome 命令本身**不挂** welcome 功能开关：否则开关一关，
//    管理员就再也进不来把它打开。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK, WELCOME } from "../config/constants.js";
import { setFeature, getFeatureMap } from "../services/features.js";
import {
  getWelcomeConfig, setWelcomeConfig, clearWelcomeConfig,
  welcomeScopeKey, welcomeMessageText
} from "../services/welcome.js";
import { clearGuideSessions } from "../services/sessions.js";
import { logAdminAction } from "../services/admin-log.js";
import { logError } from "../core/logger.js";

const SESSION_TTL_MINUTES = 30;

// ==========================================
// 引导会话（编辑欢迎语）
// ==========================================

async function getSession(env, chatId) {
  if (!env?.DB || !chatId) return null;
  return env.DB.prepare(
    `SELECT * FROM welcome_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
}

async function setSession(env, chatId) {
  await env.DB.prepare(`
    INSERT INTO welcome_sessions (chat_id, updated_at) VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).bind(chatId).run();
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM welcome_sessions WHERE chat_id = ?").bind(chatId).run();
}

/** 管理员是否正在编辑欢迎语（群里未 @ 的文本也要放行） */
export async function isWelcomeGuideActive(env, chatId) {
  if (!env?.DB || !chatId) return false;
  return Boolean(await getSession(env, chatId));
}

/** 取消编辑 */
export async function cancelWelcomeGuide({ env, token, chatId }) {
  if (env?.DB) await clearSession(env, chatId);
  return sendMessage(token, chatId, "🚫 已取消编辑欢迎语。");
}

/**
 * 处理欢迎语输入。
 * @returns {Promise<boolean>} true 表示这条消息已被消费
 */
export async function handleWelcomeGuideInput({ env, token, chatId, userText }) {
  if (!env?.DB) return false;
  const session = await getSession(env, chatId);
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  // 发送「-」= 恢复默认文案
  if (text === "-") {
    await clearWelcomeConfig(env, chatId, "text");
    await clearSession(env, chatId);
    await sendMessage(token, chatId, "✅ 已恢复默认欢迎语。");
    await renderWelcomePanel(token, env, chatId, null);
    return true;
  }

  if (text.length > WELCOME.TEXT_MAX) {
    await sendMessage(
      token, chatId,
      `⚠️ 欢迎语太长了（${text.length} 字，上限 ${WELCOME.TEXT_MAX} 字），请精简后重新发送。`
    );
    return true;
  }

  await setWelcomeConfig(env, chatId, "text", text);
  await clearSession(env, chatId);
  await sendMessage(token, chatId, "✅ 欢迎语已保存。");
  await renderWelcomePanel(token, env, chatId, null);
  return true;
}

// ==========================================
// 面板
// ==========================================

/** 面板键盘（纯函数，供排版测试直接校验） */
export function getWelcomePanelKeyboard({ enabled, verify, kick, timeoutMin }) {
  return {
    inline_keyboard: [
      ...grid([
        { text: enabled ? "🔛 本群：已开启" : "🔛 本群：已关闭", callback_data: ADMIN_CALLBACK.WELCOME_TOGGLE },
        { text: verify ? "🔒 验证：开启" : "🔓 验证：关闭", callback_data: ADMIN_CALLBACK.WELCOME_VERIFY }
      ]),
      ...grid([
        { text: `⏱ 超时：${Number(timeoutMin) || WELCOME.DEFAULT_TIMEOUT_MIN} 分钟`, callback_data: ADMIN_CALLBACK.WELCOME_TIMEOUT_PREFIX },
        { text: kick ? "👢 超时移出：是" : "🤝 超时移出：否", callback_data: ADMIN_CALLBACK.WELCOME_KICK }
      ]),
      ...grid([
        { text: "✏️ 编辑欢迎语", callback_data: ADMIN_CALLBACK.WELCOME_EDIT },
        { text: "♻️ 恢复默认", callback_data: ADMIN_CALLBACK.WELCOME_RESET }
      ]),
      [{ text: "❌ 关闭", callback_data: ADMIN_CALLBACK.CLOSE }]
    ]
  };
}

/** 渲染入群欢迎面板（群里） */
export async function renderWelcomePanel(token, env, chatId, messageId, uctx = null) {
  if (!env?.DB) {
    return sendMessage(token, chatId, "❌ 未绑定数据库。");
  }

  const isGroup = uctx ? (uctx.chatType === "group" || uctx.chatType === "supergroup") : String(chatId).startsWith("-");
  if (!isGroup) {
    const text =
      `👋 <b>入群欢迎与验证</b>\n${LAYOUT.DIVIDER}\n` +
      `欢迎与验证是<b>按群</b>设置的。请把机器人拉进目标群并设为管理员，然后在<b>群里</b>发送 <code>/welcome</code>。`;
    return messageId
      ? editMessageText(token, chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] }, "HTML")
      : sendMessageWithKeyboard(token, chatId, text, { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] }, "HTML");
  }

  const config = await getWelcomeConfig(env, chatId);
  const map = await getFeatureMap(env, welcomeScopeKey(chatId));
  const enabled = map.welcome !== false;

  let pending = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM join_verifications WHERE chat_id = ? AND status = 'pending'"
    ).bind(String(chatId)).first();
    pending = Number(row?.n) || 0;
  } catch (e) {
    logError("统计待验证成员失败：", e);
  }

  const preview = welcomeMessageText(config, {
    name: "新成员",
    group: "本群",
    restricted: config.verify
  });
  const template = String(config.text || "").trim() || WELCOME.DEFAULT_TEXT;

  let text = `👋 <b>入群欢迎与验证</b>\n${LAYOUT.DIVIDER}\n`;
  text += `${enabled ? "🟢 <b>已开启</b>" : "🔴 <b>已关闭</b>"}`;
  text += `　·　验证：${config.verify ? "开启" : "关闭"}\n`;
  text += `⏱ 超时：<b>${config.timeoutMin} 分钟</b>　·　超时处理：<b>${config.kick ? "移出群聊" : "仅解除限制"}</b>\n`;
  if (config.verify) text += `🕒 当前待验证：<b>${pending}</b> 人\n`;
  text += `\n📝 <b>欢迎语模板</b>（<code>{name}</code> 新成员，<code>{group}</code> 群名）\n`;
  text += `<code>${escapeHtml(template)}</code>\n`;
  text += `\n👀 <b>实际效果</b>\n${preview}\n`;
  if (!enabled) {
    text += `\n💡 现在是关闭状态，新成员入群不会有任何动作。点上面的「🔛」即可开启。\n`;
  }
  if (config.verify) {
    text += `\n🔒 开启验证后：机器人会先<b>限制新成员发言</b>，对方点「✅ 我已阅读群规」才放开。\n`;
    text += `需要机器人在本群是管理员并有「<b>封禁用户</b>」权限。\n`;
  }

  const keyboard = getWelcomePanelKeyboard({
    enabled, verify: config.verify, kick: config.kick, timeoutMin: config.timeoutMin
  });
  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 面板与引导的统一入口（callback 里调用） */
export async function handleWelcomeCallback({
  env, ctx, token, callback, data, chatId, userId, messageId
}) {
  const config = await getWelcomeConfig(env, chatId);
  const map = await getFeatureMap(env, welcomeScopeKey(chatId));
  const enabled = map.welcome !== false;

  const refresh = async (notice) => {
    await renderWelcomePanel(token, env, chatId, messageId);
    await answerCallback(token, callback.id, notice);
  };

  switch (data) {
    case ADMIN_CALLBACK.WELCOME_TOGGLE: {
      const next = !enabled;
      await setFeature(env, welcomeScopeKey(chatId), "welcome", next);
      await logAdminAction(env, {
        adminId: userId, chatId, action: "welcome_toggle", detail: next ? "开启" : "关闭"
      });
      return refresh(next ? "已开启入群欢迎" : "已关闭入群欢迎");
    }

    case ADMIN_CALLBACK.WELCOME_VERIFY: {
      const next = !config.verify;
      await setWelcomeConfig(env, chatId, "verify", next ? "on" : "off");
      await logAdminAction(env, {
        adminId: userId, chatId, action: "welcome_verify", detail: next ? "开启" : "关闭"
      });
      return refresh(next ? "已开启验证" : "已关闭验证");
    }

    case ADMIN_CALLBACK.WELCOME_KICK: {
      const next = !config.kick;
      await setWelcomeConfig(env, chatId, "kick", next ? "on" : "off");
      await logAdminAction(env, {
        adminId: userId, chatId, action: "welcome_kick", detail: next ? "移出群聊" : "仅解除限制"
      });
      return refresh(next ? "超时未验证将移出群聊" : "超时未验证仅解除限制");
    }

    case ADMIN_CALLBACK.WELCOME_RESET: {
      await clearWelcomeConfig(env, chatId, "text");
      await logAdminAction(env, { adminId: userId, chatId, action: "welcome_reset", detail: "恢复默认欢迎语" });
      return refresh("已恢复默认欢迎语");
    }

    case ADMIN_CALLBACK.WELCOME_EDIT: {
      // 引导会话互斥：开新流程前清掉同会话的其它流程状态
      await clearGuideSessions(env, chatId);
      await setSession(env, chatId);
      await answerCallback(token, callback.id, "请发送新的欢迎语");
      await sendMessage(
        token, chatId,
        `✏️ <b>编辑欢迎语</b>\n${LAYOUT.DIVIDER}\n` +
        `请直接回复新的欢迎语正文（最多 ${WELCOME.TEXT_MAX} 字）。\n` +
        `可用占位符：<code>{name}</code> = 新成员，<code>{group}</code> = 本群名称。\n\n` +
        `• 发送 <code>/cancel</code> 放弃编辑\n` +
        `• 发送 <code>-</code> 恢复默认文案\n\n` +
        `当前模板：\n<code>${escapeHtml(String(config.text || "").trim() || WELCOME.DEFAULT_TEXT)}</code>`,
        "HTML"
      );
      return;
    }

    default:
      break;
  }

  // ⏱ 超时时长：点一次往后轮换一个候选
  if (data.startsWith(ADMIN_CALLBACK.WELCOME_TIMEOUT_PREFIX)) {
    const list = WELCOME.TIMEOUT_CHOICES;
    const index = list.indexOf(Number(config.timeoutMin));
    const next = list[(index + 1) % list.length];
    await setWelcomeConfig(env, chatId, "timeout_min", next);
    await logAdminAction(env, {
      adminId: userId, chatId, action: "welcome_timeout", detail: `${next} 分钟`
    });
    return refresh(`超时已设为 ${next} 分钟`);
  }

  await answerCallback(token, callback.id, "⚠️ 未知操作", true);
}

// ==========================================
// 命令入口（/welcome）
// ==========================================

export async function cmdWelcome({ env, token, chatId, isGroupCtx, uctx }) {
  if (!isGroupCtx) {
    return sendMessage(
      token, chatId,
      `👋 <b>入群欢迎与验证</b>\n${LAYOUT.DIVIDER}\n` +
      `请到<b>群里</b>发送 <code>/welcome</code> 来配置（欢迎语与验证都是按群生效的）。`,
      "HTML"
    );
  }
  return renderWelcomePanel(token, env, chatId, null, uctx);
}
