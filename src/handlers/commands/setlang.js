// ==========================================
// /setlang
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { saveSceneConfig } from "../../services/users.js";

export async function cmdSetLang({ env, ctx, token, chatId, uctx, userConfig, isGroupCtx, rawText }) {
  const arg = rawText.replace(/^\/setlang(@\w+)?/i, "").trim().toLowerCase();
  if (arg === "zh" || arg === "en") {
    userConfig.lang = arg;
    await saveSceneConfig(env, uctx, userConfig);
    await sendAutoDelete(token, chatId, `✅ 偏好语言已修改为：${arg === "zh" ? "中文" : "English"}`, null, isGroupCtx, ctx);
  } else {
    await sendAutoDelete(token, chatId, "⚠️ 使用方法：\n/setlang zh - 设置为中文\n/setlang en - 设置为英文", null, isGroupCtx, ctx);
  }
}