// ==========================================
// ⚙️ 功能开关（管理端）
//   scopeToken = "g"        → 全局默认
//   scopeToken = "s<rowId>" → 某个场景（场景行 ID）
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { GLOBAL_SCOPE, FEATURES, getFeatureMap, getExplicitSettings, setFeature, clearFeatureOverride } from "../services/features.js";
import { logAdminAction } from "../services/admin-log.js";
import { ADMIN_CALLBACK } from "../config/constants.js";

/** 把 scopeToken 解析成 { scopeKey, rowId } */
async function resolveScope(env, scopeToken) {
  if (scopeToken === "g") return { scopeKey: GLOBAL_SCOPE, rowId: null, title: "🌍 全局默认" };

  const rowId = Number.parseInt(String(scopeToken).replace(/^s/, ""), 10);
  if (!Number.isInteger(rowId)) return null;

  const scene = await env.DB.prepare(
    "SELECT id, scene_key, chat_type, first_name, user_id, chat_id FROM user_scenes WHERE id = ?"
  ).bind(rowId).first();
  if (!scene) return null;

  const isGroup = scene.chat_type === "group" || scene.chat_type === "supergroup";
  const title = isGroup
    ? `👥 群 <code>${escapeHtml(scene.chat_id)}</code>`
    : `💬 ${escapeHtml(scene.first_name || scene.user_id || scene.scene_key)}`;
  return { scopeKey: scene.scene_key, rowId, title, scene };
}

export async function renderFeatureMenu(token, env, chatId, messageId, scopeToken = "g") {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  const scope = await resolveScope(env, scopeToken);
  if (!scope) {
    return editMessageText(token, chatId, messageId, "❌ 场景不存在或已被删除。",
      { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] });
  }

  const effective = await getFeatureMap(env, scope.scopeKey);
  const explicit = await getExplicitSettings(env, scope.scopeKey);
  const isGlobal = scope.rowId === null;

  let text = `⚙️ <b>功能开关</b> · ${scope.title}\n`;
  text += `-------------------------\n`;
  if (isGlobal) {
    text += `这里设置的是<b>所有场景的默认值</b>；单个场景可以在「场景编辑 → 🧩 本场景功能」里单独覆盖。\n\n`;
  } else {
    text += `这里设置只影响该场景；未单独设置的项目<b>跟随全局默认</b>。\n\n`;
  }

  for (const f of FEATURES) {
    const on = effective[f.key] !== false;
    const tag = explicit[f.key] === undefined ? (isGlobal ? "" : "（跟随全局）") : "（本场景已设置）";
    text += `${on ? "✅" : "🚫"} <b>${f.label}</b>${tag}\n    └ ${f.desc}\n`;
  }

  const inline_keyboard = [];
  for (const f of FEATURES) {
    const on = effective[f.key] !== false;
    inline_keyboard.push([
      {
        text: `${on ? "✅" : "🚫"} ${f.label}${on ? "（点击关闭）" : "（点击开启）"}`,
        callback_data: `${ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX}${scopeToken}_${f.key}`
      }
    ]);
  }

  if (!isGlobal) {
    inline_keyboard.push([{ text: "🔄 全部恢复跟随全局", callback_data: `${ADMIN_CALLBACK.FEATURES_RESET_PREFIX}${scope.rowId}` }]);
  }
  inline_keyboard.push([
    isGlobal
      ? { text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }
      : { text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${scope.rowId}` }
  ]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

/** 切换单个开关 */
export async function handleFeatureToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rest = String(data).replace(ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX, "");
  const sep = rest.indexOf("_");
  const scopeToken = sep === -1 ? rest : rest.slice(0, sep);
  const feature = sep === -1 ? "" : rest.slice(sep + 1);

  const scope = await resolveScope(env, scopeToken);
  if (!scope) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const effective = await getFeatureMap(env, scope.scopeKey);
  const next = effective[feature] === false; // 当前关闭 → 打开

  await setFeature(env, scope.scopeKey, feature, next);
  await logAdminAction(env, {
    adminId, chatId,
    action: "feature_toggle",
    detail: `${scope.scopeKey} ${feature} → ${next ? "开启" : "关闭"}`
  });

  await answerCallback(token, callback.id, `${next ? "✅ 已开启" : "🚫 已关闭"}：${feature}`);
  await renderFeatureMenu(token, env, chatId, msgId, scopeToken);
}

/** 清除该场景的所有覆盖，恢复跟随全局 */
export async function handleFeatureReset({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rowId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.FEATURES_RESET_PREFIX, ""), 10);
  if (!Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare("SELECT scene_key FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  for (const f of FEATURES) {
    await clearFeatureOverride(env, scene.scene_key, f.key);
  }

  await logAdminAction(env, {
    adminId, chatId, action: "feature_reset", detail: scene.scene_key
  });

  await answerCallback(token, callback.id, "🔄 已恢复跟随全局");
  await renderFeatureMenu(token, env, chatId, msgId, `s${rowId}`);
}
