// ==========================================
// ⚙️ 功能开关（管理端）
//
// 三级结构：
//   🌍 全局设置     → 每个开关的默认值
//   👥 群聊场景     → 选一个群 → 该群的开关
//   💬 私聊场景     → 选一个用户 → 该用户的开关
//
// 场景里改过才会覆盖全局；也可以一键「恢复跟随全局」。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import {
  GLOBAL_SCOPE, FEATURES, getFeatureMap, getExplicitSettings,
  setFeature, clearFeatureOverrides
} from "../services/features.js";
import { logAdminAction } from "../services/admin-log.js";

const SCENES_PER_PAGE = 8;
const LABEL_MAX = 12;

/** 菜单按钮文案统一走 compactLabel，避免溢出与截断 emoji */
const short = (text, n = LABEL_MAX) => compactLabel(text, n);

/** 功能开关首页键盘（纯函数，便于排版测试） */
export function getFeatureHomeKeyboard() {
  return {
    inline_keyboard: grid([
      { text: "🌍 全局设置", callback_data: ADMIN_CALLBACK.FEATURES_GLOBAL },
      { text: "👥 群聊场景", callback_data: `${ADMIN_CALLBACK.FEATURES_GROUP_PREFIX}1` },
      { text: "💬 私聊场景", callback_data: `${ADMIN_CALLBACK.FEATURES_PRIVATE_PREFIX}1` },
      { text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }
    ])
  };
}

// ---------- 首页：三个作用域 ----------
/** 功能开关首页：全局 / 群聊场景 / 私聊场景 三个入口 */
export async function renderFeatureHome(token, env, chatId, messageId) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  const global = await getExplicitSettings(env, GLOBAL_SCOPE);
  const offGlobal = FEATURES.filter((f) => global[f.key] === false);

  let text = `⚙️ <b>功能开关</b>\n`;
  text += `-------------------------\n`;
  text += `分三层设置，<b>场景里改过才会覆盖全局</b>：\n\n`;
  text += `🌍 <b>全局设置</b> —— 所有私聊与群聊的默认值`;
  text += offGlobal.length ? `（已关闭：${offGlobal.map((f) => f.label).join("、")}）\n` : `（当前全部开启）\n`;
  text += `👥 <b>群聊场景</b> —— 单独为某个群开关\n`;
  text += `💬 <b>私聊场景</b> —— 单独为某个用户开关\n`;

  return editMessageText(token, chatId, messageId, text, getFeatureHomeKeyboard(), "HTML");
}

// ---------- 场景列表（群聊 / 私聊）----------
/** 场景选择列表（分页，两列网格） */
async function renderScenePicker(token, env, chatId, messageId, kind, page = 1) {
  const isGroup = kind === "group";
  const where = isGroup
    ? "WHERE s.chat_type IN ('group','supergroup')"
    : "WHERE s.chat_type = 'private'";

  const countRes = await env.DB.prepare(`SELECT COUNT(*) AS total FROM user_scenes s ${where}`).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, SCENES_PER_PAGE);
  // 页码越界时收敛回最后一页，否则会查出空列表且没有返回路径
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(`
    SELECT s.id, s.scene_key, s.chat_id, s.user_id, s.first_name, s.username,
           COALESCE(u.points, 0) AS points
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    ${where}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(SCENES_PER_PAGE, pageOffset(safePage, SCENES_PER_PAGE)).all();

  const rows = results || [];

  let text = `${isGroup ? "👥 <b>群聊场景</b>" : "💬 <b>私聊场景</b>"}\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 个）\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `点一个场景进去设置它的开关：\n\n`;

  const inline_keyboard = [];

  if (rows.length === 0) {
    text += `<i>还没有记录。</i>\n`;
  } else {
    // 两列网格：8 个场景 = 4 行，加上翻页与返回也不会超过 8 行
    const buttons = rows.map((row) => {
      const name = isGroup ? `群 ${row.chat_id}` : (row.first_name || row.user_id || "未命名");
      return {
        text: `${isGroup ? "🏠" : "👤"} ${short(name)}`,
        callback_data: `${ADMIN_CALLBACK.FEATURES_SCENE_PREFIX}${row.id}`
      };
    });
    inline_keyboard.push(...grid(buttons));
  }

  const prefix = isGroup ? ADMIN_CALLBACK.FEATURES_GROUP_PREFIX : ADMIN_CALLBACK.FEATURES_PRIVATE_PREFIX;
  const navRow = pagerRow({ page: safePage, totalPages, prefix });
  if (navRow) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "🔙 返回功能开关", callback_data: ADMIN_CALLBACK.FEATURES_HOME }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 某个作用域的开关列表 ----------
/** 单个作用域（全局或某个场景）的开关面板 */
async function renderSwitchMenu(token, env, chatId, messageId, { scopeKey, title, rowId = null }) {
  const effective = await getFeatureMap(env, scopeKey);
  const explicit = await getExplicitSettings(env, scopeKey);
  const isGlobal = scopeKey === GLOBAL_SCOPE;

  let text = `⚙️ <b>${title}</b>\n`;
  text += `-------------------------\n`;
  text += isGlobal
    ? `这是<b>全局默认值</b>，场景没单独设置时就用它。\n\n`
    : `只影响这个场景；未设置的项目<b>跟随全局</b>。\n\n`;

  for (const f of FEATURES) {
    const on = effective[f.key] !== false;
    const tag = explicit[f.key] === undefined ? (isGlobal ? "" : "（跟随全局）") : "（本场景已设置）";
    text += `${on ? "✅" : "🚫"} <b>${f.label}</b>${tag}\n`;
  }

  const scopeToken = isGlobal ? "g" : `s${rowId}`;
  const buttons = FEATURES.map((f) => ({
    text: `${effective[f.key] === false ? "🚫" : "✅"} ${f.label}`,
    callback_data: `${ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX}${scopeToken}_${f.key}`
  }));
  const inline_keyboard = grid(buttons);

  if (isGlobal) {
    inline_keyboard.push([{ text: "🔙 返回功能开关", callback_data: ADMIN_CALLBACK.FEATURES_HOME }]);
  } else {
    inline_keyboard.push([{ text: "🔄 全部恢复跟随全局", callback_data: `${ADMIN_CALLBACK.FEATURES_RESET_PREFIX}${rowId}` }]);
    inline_keyboard.push([{ text: "🔙 返回场景菜单", callback_data: `admin_manage_user_${rowId}` }]);
  }

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 对外入口 ----------
/**
 * 统一的开关面板入口。
 * scopeToken 约定：g = 全局；gl<页码> = 群聊场景列表；pl<页码> = 私聊场景列表；s<行ID> = 某个场景。
 */
export async function renderFeatureScope(token, env, chatId, messageId, scopeToken) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  if (scopeToken.startsWith("gl")) {
    return renderScenePicker(token, env, chatId, messageId, "group", Number.parseInt(scopeToken.slice(2), 10) || 1);
  }
  if (scopeToken.startsWith("pl")) {
    return renderScenePicker(token, env, chatId, messageId, "private", Number.parseInt(scopeToken.slice(2), 10) || 1);
  }
  if (scopeToken === "g") {
    return renderSwitchMenu(token, env, chatId, messageId, {
      scopeKey: GLOBAL_SCOPE, title: "🌍 全局功能开关"
    });
  }

  const rowId = Number.parseInt(String(scopeToken).replace(/^s/, ""), 10);
  if (!Number.isInteger(rowId)) {
    return editMessageText(token, chatId, messageId, "⚠️ 参数无效。");
  }

  const scene = await env.DB.prepare(
    "SELECT id, scene_key, chat_type, chat_id, first_name, user_id FROM user_scenes WHERE id = ?"
  ).bind(rowId).first();
  if (!scene) {
    return editMessageText(token, chatId, messageId, "❌ 场景不存在或已被删除。",
      { inline_keyboard: [[{ text: "🔙 返回功能开关", callback_data: ADMIN_CALLBACK.FEATURES_HOME }]] });
  }

  const isGroup = scene.chat_type === "group" || scene.chat_type === "supergroup";
  const title = isGroup
    ? `👥 群 <code>${escapeHtml(scene.chat_id)}</code>`
    : `💬 ${escapeHtml(scene.first_name || scene.user_id || scene.scene_key)}`;

  return renderSwitchMenu(token, env, chatId, messageId, {
    scopeKey: scene.scene_key, title: `${title} · 功能开关`, rowId
  });
}

// ---------- 切换开关 ----------
/** 点击开关按钮：当前关闭就打开，当前开启就关闭（写场景级覆盖） */
export async function handleFeatureToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rest = String(data).replace(ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX, "");
  const sep = rest.indexOf("_");
  const scopeToken = sep === -1 ? rest : rest.slice(0, sep);
  const feature = sep === -1 ? "" : rest.slice(sep + 1);

  let scopeKey;
  let rowId = null;

  if (scopeToken === "g") {
    scopeKey = GLOBAL_SCOPE;
  } else {
    rowId = Number.parseInt(String(scopeToken).replace(/^s/, ""), 10);
    if (!Number.isInteger(rowId)) {
      await answerCallback(token, callback.id, "⚠️ 参数无效", true);
      return;
    }
    const scene = await env.DB.prepare("SELECT scene_key FROM user_scenes WHERE id = ?").bind(rowId).first();
    if (!scene) {
      await answerCallback(token, callback.id, "❌ 场景不存在", true);
      return;
    }
    scopeKey = scene.scene_key;
  }

  const effective = await getFeatureMap(env, scopeKey);
  const next = effective[feature] === false; // 当前关闭 → 打开

  if (!(await setFeature(env, scopeKey, feature, next))) {
    await answerCallback(token, callback.id, "❌ 未知的开关", true);
    return;
  }

  await logAdminAction(env, {
    adminId, chatId,
    action: "feature_toggle",
    detail: `${scopeKey} ${feature} → ${next ? "开启" : "关闭"}`
  });

  await answerCallback(token, callback.id, `${next ? "✅ 已开启" : "🚫 已关闭"}`);
  await renderFeatureScope(token, env, chatId, msgId, scopeToken === "g" ? "g" : `s${rowId}`);
}

// ---------- 恢复跟随全局 ----------
/** 清掉该场景的全部覆盖，重新跟随全局设置 */
export async function handleFeatureReset({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rowId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.FEATURES_RESET_PREFIX, ""), 10);
  if (!Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare("SELECT scene_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const cleared = await clearFeatureOverrides(env, scene.scene_key);
  await logAdminAction(env, {
    adminId, chatId, action: "feature_reset", detail: `${scene.scene_key}（清除 ${cleared} 项）`
  });

  await answerCallback(token, callback.id, "🔄 已恢复跟随全局");
  await renderFeatureScope(token, env, chatId, msgId, `s${rowId}`);
}
