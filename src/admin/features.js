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
  getFeatureSources, setFeature, clearFeatureOverrides,
  groupKeyOfScene
} from "../services/features.js";
import { describeSource } from "../services/config.js";
import { buildGroupScopeKey } from "../core/context.js";
import { logAdminAction } from "../services/admin-log.js";

const SCENES_PER_PAGE = 8;
/**
 * 开关列表每页显示几个（两列 = 3 行）。
 * 功能变多之后（v3.10.0 到了 14 个）一页铺满会顶破「整菜单 ≤ 8 行」的约定，
 * 所以这里分页：3 行开关 + 1 行翻页 + 1~2 行返回，最多 6 行。
 */
const SWITCHES_PER_PAGE = 6;
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
/**
 * 场景选择列表（分页，两列网格）。
 *
 * 群聊**按群聚合**（v3.9.0）：原先每个群成员一条记录，同一个群会重复出现好几遍，
 * 而且点进去写的是成员级 scene_key —— 与 /welcome 这类群级功能各写各的 key，
 * 结果就是「功能开关面板点了没反应」。现在一个群一条，写群级键 `group:<群ID>`。
 */
async function renderScenePicker(token, env, chatId, messageId, kind, page = 1) {
  const isGroup = kind === "group";

  const countRes = isGroup
    ? await env.DB.prepare(
      "SELECT COUNT(DISTINCT chat_id) AS total FROM user_scenes WHERE chat_type IN ('group','supergroup')"
    ).first()
    : await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM user_scenes WHERE chat_type = 'private'"
    ).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, SCENES_PER_PAGE);
  // 页码越界时收敛回最后一页，否则会查出空列表且没有返回路径
  const safePage = clampPage(page, totalPages);

  const { results } = isGroup
    ? await env.DB.prepare(`
        SELECT s.chat_id AS chat_id, MIN(s.id) AS id, MAX(s.updated_at) AS updated_at
        FROM user_scenes s
        WHERE s.chat_type IN ('group','supergroup')
        GROUP BY s.chat_id
        ORDER BY MAX(s.updated_at) DESC
        LIMIT ? OFFSET ?
      `).bind(SCENES_PER_PAGE, pageOffset(safePage, SCENES_PER_PAGE)).all()
    : await env.DB.prepare(`
        SELECT s.id, s.scene_key, s.chat_id, s.user_id, s.first_name, s.username,
               COALESCE(u.points, 0) AS points
        FROM user_scenes s
        LEFT JOIN users u ON u.user_key = s.user_key
        WHERE s.chat_type = 'private'
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `).bind(SCENES_PER_PAGE, pageOffset(safePage, SCENES_PER_PAGE)).all();

  const rows = results || [];

  let text = `${isGroup ? "👥 <b>群聊场景</b>" : "💬 <b>私聊场景</b>"}\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 个${isGroup ? "群" : "用户"}）\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += isGroup
    ? `点一个群进去设置它的开关（<b>按群生效</b>，本群所有成员都受影响）：\n\n`
    : `点一个场景进去设置它的开关：\n\n`;

  const inline_keyboard = [];

  if (rows.length === 0) {
    text += `<i>还没有记录。</i>\n`;
  } else {
    // 两列网格：8 个场景 = 4 行，加上翻页与返回也不会超过 8 行
    const buttons = rows.map((row) => {
      const name = isGroup ? `群 ${row.chat_id}` : (row.first_name || row.user_id || "未命名");
      const scopeToken = isGroup ? `gc${row.chat_id}` : `s${row.id}`;
      return {
        text: `${isGroup ? "🏠" : "👤"} ${short(name)}`,
        callback_data: `${ADMIN_CALLBACK.FEATURES_SCENE_PREFIX}${scopeToken}`
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
/**
 * 单个作用域（全局 / 某个群 / 某个场景）的开关面板。
 * scopeToken 会原样回填到按钮回调里，所以它必须与 renderFeatureScope 的解析规则一致。
 */
async function renderSwitchMenu(token, env, chatId, messageId, { scopeKey, title, scopeToken, page = 1 }) {
  const effective = await getFeatureMap(env, scopeKey);
  const sources = await getFeatureSources(env, scopeKey);
  const isGlobal = scopeKey === GLOBAL_SCOPE;
  // `group:<群ID>` 这种纯群键 vs `group:<群ID>:user:<成员ID>` 这种成员场景
  const isGroupScope = !isGlobal && /^group:[^:]+$/.test(String(scopeKey));
  const sourceOpts = isGroupScope
    ? { groupKey: scopeKey }
    : { sceneKey: scopeKey, groupKey: groupKeyOfScene(scopeKey) };

  const totalPages = totalPagesOf(FEATURES.length, SWITCHES_PER_PAGE);
  const safePage = clampPage(page, totalPages);
  const offset = pageOffset(safePage, SWITCHES_PER_PAGE);
  const visible = FEATURES.slice(offset, offset + SWITCHES_PER_PAGE);

  let text = `⚙️ <b>${title}</b>\n`;
  text += `-------------------------\n`;
  if (totalPages > 1) text += `第 <b>${safePage} / ${totalPages}</b> 页（共 ${FEATURES.length} 项）\n`;
  text += isGlobal
    ? `这是<b>全局默认值</b>，场景没单独设置时就用它。\n\n`
    : (isGroupScope
      ? `只影响<b>这个群</b>；未设置的项目<b>跟随全局</b>。\n\n`
      : `只影响这个场景；未设置的项目<b>跟随全局</b>。\n\n`);

  for (const f of visible) {
    const on = effective[f.key] !== false;
    // 来源统一用配置模型描述：本场景 / 本群 / 全局 / 内置默认
    const tag = `（${describeSource(sources[f.key] || null, sourceOpts)}）`;
    text += `${on ? "✅" : "🚫"} <b>${f.label}</b>${tag}\n`;
  }

  // ⚠️ 按钮里回填的 scopeToken 必须是**干净**的（不带页码），
  // 否则 handleFeatureToggle 解析 `gc<群ID>` 时会多出一截 "~2"，群 ID 就废了。
  const buttons = visible.map((f) => ({
    text: `${effective[f.key] === false ? "🚫" : "✅"} ${f.label}`,
    callback_data: `${ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX}${scopeToken}_${f.key}`
  }));
  const inline_keyboard = grid(buttons);

  // 翻页：页码附在 scopeToken 后面（用 ~ 分隔，scopeToken 本身不含它）
  const nav = pagerRow({
    page: safePage, totalPages, prefix: `${ADMIN_CALLBACK.FEATURES_SCENE_PREFIX}${scopeToken}~`
  });
  if (nav) inline_keyboard.push(nav);

  if (isGlobal) {
    inline_keyboard.push([{ text: "🔙 返回功能开关", callback_data: ADMIN_CALLBACK.FEATURES_HOME }]);
  } else {
    inline_keyboard.push([{ text: "🔄 全部恢复跟随全局", callback_data: `${ADMIN_CALLBACK.FEATURES_RESET_PREFIX}${scopeToken}` }]);
    inline_keyboard.push([isGroupScope
      ? { text: "🔙 返回群列表", callback_data: `${ADMIN_CALLBACK.FEATURES_GROUP_PREFIX}1` }
      : { text: "🔙 返回场景菜单", callback_data: `admin_manage_user_${String(scopeToken).replace(/^s/, "")}` }
    ]);
  }

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 对外入口 ----------
/**
 * 统一的开关面板入口。
 * scopeToken 约定：g = 全局；gl<页码> = 群聊列表；pl<页码> = 私聊列表；
 *                  gc<群ID> = 某个群（群级）；s<行ID> = 某个成员场景。
 */
export async function renderFeatureScope(token, env, chatId, messageId, scopeToken) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  // 页码用 ~ 附在作用域 token 后面（例如 gc-100123~2 = 群 -100123 的第 2 页）
  const raw = String(scopeToken ?? "");
  const tilde = raw.lastIndexOf("~");
  const scope = tilde === -1 ? raw : raw.slice(0, tilde);
  const page = tilde === -1 ? 1 : (Number.parseInt(raw.slice(tilde + 1), 10) || 1);

  if (scope.startsWith("gl")) {
    return renderScenePicker(token, env, chatId, messageId, "group", Number.parseInt(scope.slice(2), 10) || 1);
  }
  if (scope.startsWith("pl")) {
    return renderScenePicker(token, env, chatId, messageId, "private", Number.parseInt(scope.slice(2), 10) || 1);
  }
  if (scope === "g") {
    return renderSwitchMenu(token, env, chatId, messageId, {
      scopeKey: GLOBAL_SCOPE, title: "🌍 全局功能开关", scopeToken: "g", page
    });
  }

  // 群级作用域：写 `group:<群ID>`，与 /welcome 等群级功能共用同一个键
  if (scope.startsWith("gc")) {
    const groupChatId = scope.slice(2);
    if (!groupChatId) {
      return editMessageText(token, chatId, messageId, "⚠️ 参数无效。");
    }
    return renderSwitchMenu(token, env, chatId, messageId, {
      scopeKey: buildGroupScopeKey(groupChatId),
      title: `👥 群 <code>${escapeHtml(groupChatId)}</code>`,
      scopeToken: scope, page
    });
  }

  const rowId = Number.parseInt(scope.replace(/^s/, ""), 10);
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
    scopeKey: scene.scene_key, title: `${title} · 功能开关`, scopeToken: scope, page
  });
}

// ---------- 切换开关 ----------
/**
 * 点击开关按钮：当前关闭就打开，当前开启就关闭（写该作用域的显式设置）。
 * scopeToken 与 renderFeatureScope 保持一致：g / gc<群ID> / s<行ID>。
 */
export async function handleFeatureToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rest = String(data).replace(ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX, "");
  const sep = rest.indexOf("_");
  const scopeToken = sep === -1 ? rest : rest.slice(0, sep);
  const feature = sep === -1 ? "" : rest.slice(sep + 1);

  let scopeKey;

  if (scopeToken === "g") {
    scopeKey = GLOBAL_SCOPE;
  } else if (scopeToken.startsWith("gc")) {
    const groupChatId = scopeToken.slice(2);
    if (!groupChatId) {
      await answerCallback(token, callback.id, "⚠️ 参数无效", true);
      return;
    }
    scopeKey = buildGroupScopeKey(groupChatId);
  } else {
    const rowId = Number.parseInt(String(scopeToken).replace(/^s/, ""), 10);
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
  await renderFeatureScope(token, env, chatId, msgId, scopeToken);
}

// ---------- 恢复跟随全局 ----------
/** 清掉该作用域的全部覆盖，重新跟随全局设置 */
export async function handleFeatureReset({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const scopeToken = String(data).replace(ADMIN_CALLBACK.FEATURES_RESET_PREFIX, "");

  let scopeKey;
  if (scopeToken === "g") {
    scopeKey = GLOBAL_SCOPE;
  } else if (scopeToken.startsWith("gc")) {
    const groupChatId = scopeToken.slice(2);
    if (!groupChatId) {
      await answerCallback(token, callback.id, "⚠️ 参数无效", true);
      return;
    }
    scopeKey = buildGroupScopeKey(groupChatId);
  } else {
    const rowId = Number.parseInt(String(scopeToken).replace(/^s/, ""), 10);
    if (!Number.isInteger(rowId)) return;
    const scene = await env.DB.prepare("SELECT scene_key FROM user_scenes WHERE id = ?").bind(rowId).first();
    if (!scene) {
      await answerCallback(token, callback.id, "❌ 场景不存在", true);
      return;
    }
    scopeKey = scene.scene_key;
  }

  const cleared = await clearFeatureOverrides(env, scopeKey);
  await logAdminAction(env, {
    adminId, chatId, action: "feature_reset", detail: `${scopeKey}（清除 ${cleared} 项）`
  });

  await answerCallback(token, callback.id, "🔄 已恢复跟随全局");
  await renderFeatureScope(token, env, chatId, msgId, scopeToken);
}
