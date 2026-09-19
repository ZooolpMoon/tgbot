// ==========================================
// 🧹 自动反垃圾面板（v3.10.0）
//
// 入口：群里发 /automod
//
// 能做的事：
//   • 🔛 本群开启 / 关闭自动反垃圾（写的是**群级**功能开关）
//   • 🧹 / ♻️ / 🔗 三条规则各自开关（刷屏、重复、新成员链接）
//   • ⚙️ 动作：仅删除 → 递进禁言（第 2 次起才禁言）
//   • 🔔 群里要不要发提示
//   • 📜 看最近处置记录
//
// 配置是**群级**的（scene_settings 的 group:<群ID>），与 /welcome 同一套作用域。
// 面板命令本身**不挂** automod 功能开关 —— 否则开关一关就再也进不来把它打开。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK, AUTOMOD } from "../config/constants.js";
import { getFeatureMap, setFeature } from "../services/features.js";
import {
  getAutoModConfig, setAutoModConfig, listAutoModEvents, ruleLabel
} from "../services/automod.js";
import { buildGroupScopeKey } from "../core/context.js";
import { formatAppTime } from "../services/time.js";
import { logAdminAction } from "../services/admin-log.js";
import { logError } from "../core/logger.js";

const RULES = [
  { key: "flood", icon: "🧹", label: "刷屏" },
  { key: "repeat", icon: "♻️", label: "重复" },
  { key: "link", icon: "🔗", label: "新成员链接" }
];

/** 动作的展示文案 */
function actionLabel(action) {
  return action === "mute" ? "递进禁言" : "仅删除消息";
}

/** 面板键盘（纯函数，供排版测试直接校验） */
export function getAutoModPanelKeyboard({ enabled, config }) {
  return {
    inline_keyboard: [
      ...grid([
        { text: enabled ? "🔛 本群：已开启" : "🔛 本群：已关闭", callback_data: ADMIN_CALLBACK.AUTOMOD_TOGGLE },
        { text: `⚙️ ${actionLabel(config.action)}`, callback_data: ADMIN_CALLBACK.AUTOMOD_ACTION }
      ]),
      ...grid(RULES.map((r) => ({
        text: `${r.icon} ${r.label}：${config[r.key] ? "开" : "关"}`,
        callback_data: `${ADMIN_CALLBACK.AUTOMOD_RULE_PREFIX}${r.key}`
      }))),
      ...grid([
        { text: config.notice ? "🔔 群内提示：开" : "🔕 群内提示：关", callback_data: ADMIN_CALLBACK.AUTOMOD_NOTICE },
        { text: "📜 最近记录", callback_data: ADMIN_CALLBACK.AUTOMOD_LOG }
      ]),
      [{ text: "❌ 关闭", callback_data: ADMIN_CALLBACK.CLOSE }]
    ]
  };
}

/** 渲染自动反垃圾面板（群里） */
export async function renderAutoModPanel(token, env, chatId, messageId = null, uctx = null) {
  if (!env?.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const isGroup = uctx
    ? (uctx.chatType === "group" || uctx.chatType === "supergroup")
    : String(chatId).startsWith("-");
  if (!isGroup) {
    const text =
      `🧹 <b>自动反垃圾</b>\n${LAYOUT.DIVIDER}\n` +
      `反垃圾是<b>按群</b>生效的（规则与动作都与群成员有关）。\n` +
      `请把机器人拉进目标群并设为管理员，然后在<b>群里</b>发送 <code>/automod</code>。`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] };
    return messageId
      ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
      : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
  }

  const scopeKey = buildGroupScopeKey(chatId);
  const map = await getFeatureMap(env, scopeKey);
  const enabled = map.automod !== false;
  const config = await getAutoModConfig(env, chatId);

  let total = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM automod_events WHERE chat_id = ?"
    ).bind(String(chatId)).first();
    total = Number(row?.n) || 0;
  } catch (e) {
    logError("统计反垃圾记录失败：", e);
  }

  let text = `🧹 <b>自动反垃圾</b>\n${LAYOUT.DIVIDER}\n`;
  text += `${enabled ? "🟢 <b>已开启</b>" : "🔴 <b>已关闭</b>"}　·　累计处置：<b>${total}</b> 次\n`;
  text += `⚙️ 命中后的动作：<b>${actionLabel(config.action)}</b>\n`;
  text += `🧹 刷屏：${config.flood ? "开" : "关"}（${AUTOMOD.FLOOD_WINDOW_SEC} 秒 ${AUTOMOD.FLOOD_MAX_MESSAGES} 条 / 单条 ${AUTOMOD.MAX_MESSAGE_CHARS} 字以上）\n`;
  text += `♻️ 重复：${config.repeat ? "开" : "关"}（${AUTOMOD.REPEAT_WINDOW_SEC} 秒内同一内容 ${AUTOMOD.REPEAT_MAX} 次以上）\n`;
  text += `🔗 新成员：${config.link ? "开" : "关"}（入群 ${AUTOMOD.NEWBIE_MINUTES} 分钟内禁发链接与转发）\n`;

  text += `\n🛡️ <b>豁免</b>：群主、本群管理员、机器人管理员与执法员不会被自动处置。\n`;
  if (config.action === "mute") {
    text += `⏱ 递进禁言：第 2 次起 <b>${AUTOMOD.ESCALATE_MINUTES.join(" / ")}</b> 分钟（按违规次数递增）。\n`;
  }
  if (!enabled) {
    text += `\n💡 现在是关闭状态，机器人不会删任何消息。点上面的「🔛」开启。\n`;
    text += `开启需要机器人有「删除消息」权限；要用递进禁言还需要「封禁用户」权限。\n`;
  } else {
    text += `\n💡 判定只看行为特征（频率 / 重复 / 新成员链接），<b>不解析聊天内容</b>。\n`;
  }

  const keyboard = getAutoModPanelKeyboard({ enabled, config });
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 最近处置记录（单独一页，记录多了也不挤面板） */
export async function renderAutoModLog(token, env, chatId, messageId = null) {
  const events = await listAutoModEvents(env, chatId, 10);

  let text = `📜 <b>最近自动处置记录</b>\n${LAYOUT.DIVIDER}\n`;
  if (events.length === 0) {
    text += `暂无记录。\n`;
  } else {
    text += events.map((e, i) => {
      const when = escapeHtml(formatAppTime(env, e.created_at, { seconds: false }));
      const who = escapeHtml(String(e.user_label || e.user_id || ""));
      const why = escapeHtml(ruleLabel(e.rule));
      const what = e.action === "mute" ? "禁言" : "删除";
      return `${i + 1}. ${when} ${who}　${why} → ${what}`;
    }).join("\n");
    text += `\n\n（最多显示 10 条）`;
  }

  const keyboard = {
    inline_keyboard: [
      ...grid([
        { text: "🔙 返回面板", callback_data: ADMIN_CALLBACK.AUTOMOD_HOME },
        { text: "🗑️ 清空记录", callback_data: ADMIN_CALLBACK.AUTOMOD_CLEAR }
      ])
    ]
  };
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 面板与记录页的统一回调入口（） */
export async function handleAutoModCallback({
  env, token, callback, data, chatId, userId, messageId
}) {
  const scopeKey = buildGroupScopeKey(chatId);
  const config = await getAutoModConfig(env, chatId);
  const map = await getFeatureMap(env, scopeKey);
  const enabled = map.automod !== false;

  const refresh = async (notice, toLog = false) => {
    if (toLog) await renderAutoModLog(token, env, chatId, messageId);
    else await renderAutoModPanel(token, env, chatId, messageId);
    await answerCallback(token, callback.id, notice);
  };

  switch (data) {
    case ADMIN_CALLBACK.AUTOMOD_TOGGLE: {
      const next = !enabled;
      await setFeature(env, scopeKey, "automod", next);
      await logAdminAction(env, {
        adminId: userId, chatId, action: "automod_toggle", detail: next ? "开启" : "关闭"
      });
      return refresh(next ? "已开启自动反垃圾" : "已关闭自动反垃圾");
    }

    case ADMIN_CALLBACK.AUTOMOD_ACTION: {
      const next = config.action === "mute" ? "delete" : "mute";
      await setAutoModConfig(env, chatId, { action: next });
      await logAdminAction(env, {
        adminId: userId, chatId, action: "automod_action", detail: actionLabel(next)
      });
      return refresh(next === "mute" ? "已改为递进禁言" : "已改为仅删除消息");
    }

    case ADMIN_CALLBACK.AUTOMOD_NOTICE: {
      const next = !config.notice;
      await setAutoModConfig(env, chatId, { notice: next });
      await logAdminAction(env, {
        adminId: userId, chatId, action: "automod_notice", detail: next ? "开启" : "关闭"
      });
      return refresh(next ? "已开启群内提示" : "已关闭群内提示");
    }

    case ADMIN_CALLBACK.AUTOMOD_LOG:
      await renderAutoModLog(token, env, chatId, messageId);
      await answerCallback(token, callback.id, "");
      return;

    case ADMIN_CALLBACK.AUTOMOD_HOME:
      await renderAutoModPanel(token, env, chatId, messageId);
      await answerCallback(token, callback.id, "");
      return;

    case ADMIN_CALLBACK.AUTOMOD_CLEAR: {
      await env.DB.prepare("DELETE FROM automod_events WHERE chat_id = ?").bind(String(chatId)).run();
      await logAdminAction(env, {
        adminId: userId, chatId, action: "automod_clear", detail: "清空处置记录"
      });
      return refresh("已清空记录", true);
    }

    default:
      break;
  }

  // 三条规则的开关：前缀 + key
  if (data.startsWith(ADMIN_CALLBACK.AUTOMOD_RULE_PREFIX)) {
    const key = data.slice(ADMIN_CALLBACK.AUTOMOD_RULE_PREFIX.length);
    const rule = RULES.find((r) => r.key === key);
    if (!rule) {
      await answerCallback(token, callback.id, "⚠️ 未知规则", true);
      return;
    }
    const next = !config[key];
    await setAutoModConfig(env, chatId, { [key]: next });
    await logAdminAction(env, {
      adminId: userId, chatId, action: "automod_rule", detail: `${rule.label}：${next ? "开" : "关"}`
    });
    return refresh(`${rule.label}已${next ? "开启" : "关闭"}`);
  }

  await answerCallback(token, callback.id, "⚠️ 未知操作", true);
}

// ==========================================
// 命令入口（/automod）
// ==========================================

export async function cmdAutoMod({ env, token, chatId, isGroupCtx, uctx }) {
  if (!isGroupCtx) {
    return sendMessage(
      token, chatId,
      `🧹 <b>自动反垃圾</b>\n${LAYOUT.DIVIDER}\n` +
      `请到<b>群里</b>发送 <code>/automod</code> 来配置（规则与动作都是按群生效的）。`,
      "HTML"
    );
  }
  return renderAutoModPanel(token, env, chatId, null, uctx);
}
