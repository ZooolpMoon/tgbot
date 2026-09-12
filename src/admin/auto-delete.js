// ==========================================
// 🗑️ 消息自动删除（管理端面板）
//
// 入口：管理控制台 → 🗑️ 自动删除
//   • 可以选择「🌍 全局默认」或「🏠 本场景」两套设置
//   • 按消息类型分别设置保留时长（0 秒 = 不删除）
//   • 生效顺序：本场景 → 全局 → 内置默认
//
// 群聊按「群」共享一份设置（scene_key = group:<群ID>），
// 私聊按用户（scene_key = private:<用户ID>）；私聊里机器人本来就不删消息，
// 这里设置主要给群聊用。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { logAdminAction } from "../services/admin-log.js";
import {
  AUTO_DELETE_CAP_PRESETS, AUTO_DELETE_GLOBAL_SCOPE, AUTO_DELETE_KINDS, AUTO_DELETE_PRESETS,
  autoDeleteKind, clearAutoDeleteOverride, formatAutoDeleteDelay,
  getAutoDeleteCap, setAutoDeleteCap,
  getAutoDeleteMap, getExplicitAutoDelete, resolveAutoDeleteScope,
  getAutoDeleteSources, setAutoDeleteSeconds
} from "../services/auto-delete.js";
import { describeSource } from "../services/config.js";

/** 面板里的作用域标识：g = 全局默认，c = 本场景 */
const SCOPES = ["g", "c"];

/**
 * 解析面板当前要编辑的作用域。
 * @param {object} uctx 用户上下文（回调 / 消息共用）
 * @param {string} scope "g" 或 "c"
 */
export function resolveAutoDeletePanelScope(uctx, scope = "c") {
  if (scope === "g") return { scopeKey: AUTO_DELETE_GLOBAL_SCOPE, isGlobal: true };
  const isGroup = uctx?.chatType === "group" || uctx?.chatType === "supergroup";
  const scopeKey = isGroup ? `group:${uctx.chatId}` : resolveAutoDeleteScope(uctx?.sceneKey);
  return { scopeKey, isGlobal: false };
}

/** 面板里的场景名（群显示群 ID，私聊显示名字或 ID） */
function scopeLabel(uctx, isGlobal) {
  if (isGlobal) return "🌍 全局默认";
  if (uctx?.chatType === "group" || uctx?.chatType === "supergroup") {
    return `🏠 本群（<code>${escapeHtml(uctx.chatId)}</code>）`;
  }
  return `🏠 本场景（${escapeHtml(uctx?.firstName || uctx?.userId || uctx?.chatId || "")}）`;
}

/** 某个类型的生效值文案 + 来源标记（来源来自统一配置模型） */
function valueTag(kind, effective, sources, scopeKey) {
  const sec = effective[kind.key] ?? kind.defaultSec;
  const from = describeSource(sources[kind.key] || null, { groupKey: scopeKey, sceneKey: scopeKey });
  return `${formatAutoDeleteDelay(sec)}（${from}）`;
}

/** 面板首页键盘（纯函数，便于排版测试） */
export function getAutoDeleteHomeKeyboard(scope = "c", effective = {}, explicit = {}, capSec = 0) {
  const capLabel = capSec > 0 ? formatAutoDeleteDelay(capSec) : "未设置";
  const toggleRow = [
    { text: scope === "g" ? "✅ 🌍 全局默认" : "🌍 全局默认", callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX}g` },
    { text: scope === "c" ? "✅ 🏠 本场景" : "🏠 本场景", callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX}c` }
  ];

  const kindButtons = AUTO_DELETE_KINDS.map((kind) => {
    const sec = effective[kind.key] ?? kind.defaultSec;
    const mark = explicit[kind.key] !== undefined ? "•" : "";
    return {
      text: `${kind.icon} ${kind.label}${mark} ${formatAutoDeleteDelay(sec)}`,
      callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_KIND_PREFIX}${scope}_${kind.key}`
    };
  });

  // 第一行放「全局兜底」：它优先级最高，放在最显眼的位置
  const capRow = [{ text: `🌍 全局兜底 · ${capLabel}`, callback_data: ADMIN_CALLBACK.AUTO_DELETE_CAP }];
  const rows = [toggleRow, capRow, ...grid(kindButtons)];
  rows.push([{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]);
  return { inline_keyboard: rows };
}

/** 某个类型的时长选择键盘（纯函数，便于排版测试） */
export function getAutoDeleteKindKeyboard(scope, kindKey, currentSec) {
  const buttons = AUTO_DELETE_PRESETS.map((sec) => ({
    text: `${Number(sec) === Number(currentSec) ? "✅ " : ""}${sec === 0 ? "🚫 不删除" : formatAutoDeleteDelay(sec)}`,
    callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_SET_PREFIX}${scope}_${kindKey}_${sec}`
  }));

  const rows = grid(buttons);
  rows.push([{
    text: scope === "g" ? "🔄 恢复内置默认" : "🔄 跟随全局",
    callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_SET_PREFIX}${scope}_${kindKey}_d`
  }]);
  rows.push([{ text: "🔙 返回自动删除", callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX}${scope}` }]);
  return { inline_keyboard: rows };
}

// ---------- 渲染 ----------

/** 自动删除面板首页 */
export async function renderAutoDeletePanel(token, env, chatId, messageId, uctx, scope = "c") {
  const safeScope = SCOPES.includes(scope) ? scope : "c";
  const { scopeKey, isGlobal } = resolveAutoDeletePanelScope(uctx, safeScope);
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  const effective = await getAutoDeleteMap(env, scopeKey);
  const explicit = await getExplicitAutoDelete(env, scopeKey);
  const sources = await getAutoDeleteSources(env, scopeKey);
  const capSec = await getAutoDeleteCap(env);

  let text = `🗑️ <b>消息自动删除</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `🌍 <b>全局兜底：</b>${capSec > 0 ? `所有消息 <b>${formatAutoDeleteDelay(capSec)}</b> 后一律删除` : "<i>未设置（各类型按自己的时长）</i>"}\n`;
  text += `<i>兜底是「上限」：到了这个时间，机器人所有消息都会删，不论它属于哪一类。</i>\n\n`;
  text += `当前设置范围：${scopeLabel(uctx, isGlobal)}\n`;
  text += isGlobal
    ? `这是<b>全局默认值</b>，场景没单独设置时就用它。\n\n`
    : `只影响这个场景；没设置的项目<b>跟随全局</b>。\n\n`;

  for (const kind of AUTO_DELETE_KINDS) {
    const sec = effective[kind.key] ?? kind.defaultSec;
    const tag = valueTag(kind, effective, sources, scopeKey);
    text += `${kind.icon} <b>${kind.label}</b> · ${sec > 0 ? `${formatAutoDeleteDelay(sec)}后删除` : "不删除"}\n`;
    text += `<i>${kind.desc}｜${tag}</i>\n`;
  }

  text += `\n💡 点某一类可以单独改时长；<b>0 秒 = 不删除</b>。私聊消息不受影响。\n`;
  text += `💡 长延时（≥1 分钟）由定时任务执行（每 2 分钟扫描一次，误差 ±2 分钟）。`;

  return editMessageText(
    token, chatId, messageId, text,
    getAutoDeleteHomeKeyboard(safeScope, effective, explicit, capSec), "HTML"
  );
}

/** 全局兜底设置页 */
export async function renderAutoDeleteCap(token, env, chatId, messageId) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");
  const capSec = await getAutoDeleteCap(env);

  const buttons = AUTO_DELETE_CAP_PRESETS.map((sec) => ({
    text: `${Number(sec) === Number(capSec) ? "✅ " : ""}${sec === 0 ? "🚫 不设上限" : formatAutoDeleteDelay(sec)}`,
    callback_data: `${ADMIN_CALLBACK.AUTO_DELETE_CAP_SET_PREFIX}${sec}`
  }));

  const text =
    `🌍 <b>全局兜底删除</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `当前：<b>${capSec > 0 ? `${formatAutoDeleteDelay(capSec)}后删除所有消息` : "未设置"}</b>\n\n` +
    `这是<b>最高优先级的兜底</b>：\n` +
    `• 分类型的设置照常生效（该 5 秒删的仍然 5 秒删）\n` +
    `• 到了这个时间，机器人<b>所有</b>还没被删的消息一律删除（含 AI 回复、确认卡片、公告）\n` +
    `• 也就是说实际删除时间 = 「自己的时长」与「这个上限」里更早的那个\n\n` +
    `⚠️ 说明：只对<b>设置之后</b>发出的消息生效（不会追溯删除历史消息）；\n` +
    `长延时由定时任务执行，误差约 ±2 分钟。\n\n` +
    `选择上限：`;

  return editMessageText(
    token, chatId, messageId, text,
    { inline_keyboard: [...grid(buttons), [{ text: "🔙 返回", callback_data: ADMIN_CALLBACK.AUTO_DELETE_HOME }]] },
    "HTML"
  );
}

/** 某个消息类型的时长设置页 */
export async function renderAutoDeleteKind(token, env, chatId, messageId, uctx, scope, kindKey) {
  const kind = autoDeleteKind(kindKey);
  if (!kind) {
    return editMessageText(token, chatId, messageId, "⚠️ 未知的消息类型。");
  }

  const safeScope = SCOPES.includes(scope) ? scope : "c";
  const { scopeKey, isGlobal } = resolveAutoDeletePanelScope(uctx, safeScope);
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  const effective = await getAutoDeleteMap(env, scopeKey);
  const explicit = await getExplicitAutoDelete(env, scopeKey);
  const sources = await getAutoDeleteSources(env, scopeKey);
  const sec = effective[kind.key] ?? kind.defaultSec;

  let text = `${kind.icon} <b>${kind.label} · 自动删除</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `当前设置范围：${scopeLabel(uctx, isGlobal)}\n`;
  text += `当前生效：<b>${sec > 0 ? `${formatAutoDeleteDelay(sec)}后删除` : "不删除"}</b>（${valueTag(kind, effective, sources, scopeKey)}）\n`;
  text += `内置默认：${formatAutoDeleteDelay(kind.defaultSec)}\n`;
  text += `说明：${kind.desc}\n\n`;
  text += `选择保留时长（<b>0 = 不删除</b>）：`;

  return editMessageText(
    token, chatId, messageId, text,
    getAutoDeleteKindKeyboard(safeScope, kind.key, sec), "HTML"
  );
}

// ---------- 回调处理 ----------

/**
 * 处理自动删除面板的按钮。
 * callback_data 约定：
 *   admin_autodel                    首页（本场景）
 *   admin_autodel_o_<g|c>            切换设置范围
 *   admin_autodel_k_<g|c>_<kind>     打开某一类的时长设置
 *   admin_autodel_s_<g|c>_<kind>_<n> 写入时长；n = d 表示恢复默认 / 跟随全局
 */
export async function handleAutoDeleteCallback({ env, token, callback, chatId, msgId, data, uctx, adminId = null }) {
  if (!env.DB) {
    await answerCallback(token, callback.id, "❌ 未绑定数据库", true);
    return;
  }

  const raw = String(data || "");

  if (raw === ADMIN_CALLBACK.AUTO_DELETE_HOME) {
    await answerCallback(token, callback.id, "消息自动删除");
    await renderAutoDeletePanel(token, env, chatId, msgId, uctx, "c");
    return;
  }

  // ---------- 🌍 全局兜底（注意：要在通用 s_ 之前判断，因为前缀更具体）----------
  if (raw === ADMIN_CALLBACK.AUTO_DELETE_CAP) {
    await answerCallback(token, callback.id, "全局兜底");
    await renderAutoDeleteCap(token, env, chatId, msgId);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.AUTO_DELETE_CAP_SET_PREFIX)) {
    const value = Number(raw.slice(ADMIN_CALLBACK.AUTO_DELETE_CAP_SET_PREFIX.length));
    if (!(await setAutoDeleteCap(env, value))) {
      await answerCallback(token, callback.id, "⚠️ 参数无效", true);
      return;
    }
    await logAdminAction(env, {
      adminId, chatId, action: "autodelete_cap",
      detail: value > 0 ? `全局兜底 → ${formatAutoDeleteDelay(value)}` : "取消全局兜底"
    });
    await answerCallback(token, callback.id, value > 0 ? `已设为 ${formatAutoDeleteDelay(value)}` : "已取消兜底");
    await renderAutoDeleteCap(token, env, chatId, msgId);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX)) {
    const scope = raw.slice(ADMIN_CALLBACK.AUTO_DELETE_SCOPE_PREFIX.length);
    const safeScope = SCOPES.includes(scope) ? scope : "c";
    await answerCallback(token, callback.id, safeScope === "g" ? "全局默认" : "本场景");
    await renderAutoDeletePanel(token, env, chatId, msgId, uctx, safeScope);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.AUTO_DELETE_KIND_PREFIX)) {
    const rest = raw.slice(ADMIN_CALLBACK.AUTO_DELETE_KIND_PREFIX.length);
    const sep = rest.indexOf("_");
    const scope = sep === -1 ? "c" : rest.slice(0, sep);
    const kindKey = sep === -1 ? rest : rest.slice(sep + 1);
    await answerCallback(token, callback.id, kindKey);
    await renderAutoDeleteKind(token, env, chatId, msgId, uctx, scope, kindKey);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.AUTO_DELETE_SET_PREFIX)) {
    const rest = raw.slice(ADMIN_CALLBACK.AUTO_DELETE_SET_PREFIX.length);
    const parts = rest.split("_");
    const scope = parts[0];
    const kindKey = parts[1];
    const value = parts[2];
    const kind = autoDeleteKind(kindKey);
    const safeScope = SCOPES.includes(scope) ? scope : "c";

    if (!kind) {
      await answerCallback(token, callback.id, "⚠️ 未知的消息类型", true);
      return;
    }

    const { scopeKey } = resolveAutoDeletePanelScope(uctx, safeScope);
    if (!scopeKey) {
      await answerCallback(token, callback.id, "⚠️ 无法确定场景", true);
      return;
    }

    if (value === "d") {
      await clearAutoDeleteOverride(env, scopeKey, kind.key);
      await logAdminAction(env, {
        adminId, chatId, action: "autodelete_reset",
        detail: `${scopeKey} ${kind.key} 恢复默认`
      });
      await answerCallback(token, callback.id, safeScope === "g" ? "已恢复内置默认" : "已跟随全局");
    } else {
      const sec = Number(value);
      if (!(await setAutoDeleteSeconds(env, scopeKey, kind.key, sec))) {
        await answerCallback(token, callback.id, "⚠️ 参数无效", true);
        return;
      }
      await logAdminAction(env, {
        adminId, chatId, action: "autodelete_set",
        detail: `${scopeKey} ${kind.key} → ${formatAutoDeleteDelay(sec)}`
      });
      await answerCallback(token, callback.id, `${kind.label}：${formatAutoDeleteDelay(sec)}`);
    }

    await renderAutoDeleteKind(token, env, chatId, msgId, uctx, safeScope, kind.key);
    return;
  }

  await answerCallback(token, callback.id, "⚠️ 未知操作", true);
}
