// ==========================================
// /setprompt
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { saveSceneConfig } from "../../services/users.js";

export async function cmdSetPrompt({ env, ctx, token, chatId, uctx, userConfig, isGroupCtx, rawText }) {
  const arg = rawText.replace(/^\/setprompt(@\w+)?/i, "").trim();

  if (arg === "clear" || arg === "清空") {
    userConfig.customPrompt = "";
    await saveSceneConfig(env, uctx, userConfig);
    await sendAutoDelete(token, chatId, "🧹 已清空自定义偏好！", null, isGroupCtx, ctx);
  } else if (arg) {
    userConfig.customPrompt = arg;
    await saveSceneConfig(env, uctx, userConfig);
    await sendAutoDelete(token, chatId, `✅ 自定义 AI 偏好已设置：\n"${arg}"`, null, isGroupCtx, ctx);
  } else {
    await sendAutoDelete(token, chatId, "⚠️ 使用方法：\n/setprompt 简短回答\n/setprompt clear - 清除偏好", null, isGroupCtx, ctx);
  }
}