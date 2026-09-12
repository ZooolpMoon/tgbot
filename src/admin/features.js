// ==========================================
// ⚙️ 功能开关（全局）
// v2.1.0 起只提供全局开关，不再支持单场景覆盖。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { FEATURES, getFeatureMap, setFeature } from "../services/features.js";
import { logAdminAction } from "../services/admin-log.js";
import { ADMIN_CALLBACK } from "../config/constants.js";

export async function renderFeatureMenu(token, env, chatId, messageId) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定数据库。");

  const map = await getFeatureMap(env);

  let text = `⚙️ <b>功能开关（全局）</b>\n`;
  text += `-------------------------\n`;
  text += `开关对所有私聊与群聊生效；关闭后指令、按钮、AI 回复都会被拦下。\n\n`;

  for (const f of FEATURES) {
    text += `${map[f.key] ? "✅" : "🚫"} <b>${f.label}</b>\n    └ ${f.desc}\n`;
  }

  const inline_keyboard = FEATURES.map((f) => [
    {
      text: `${map[f.key] ? "✅" : "🚫"} ${f.label}${map[f.key] ? "（点击关闭）" : "（点击开启）"}`,
      callback_data: `${ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX}${f.key}`
    }
  ]);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

export async function handleFeatureToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const feature = String(data).replace(ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX, "");
  const map = await getFeatureMap(env);
  const next = map[feature] === false; // 当前关闭 → 打开

  if (!(await setFeature(env, feature, next))) {
    await answerCallback(token, callback.id, "❌ 未知的开关", true);
    return;
  }

  await logAdminAction(env, {
    adminId, chatId,
    action: "feature_toggle",
    detail: `${feature} → ${next ? "开启" : "关闭"}`
  });

  await answerCallback(token, callback.id, `${next ? "✅ 已开启" : "🚫 已关闭"}`);
  await renderFeatureMenu(token, env, chatId, msgId);
}
