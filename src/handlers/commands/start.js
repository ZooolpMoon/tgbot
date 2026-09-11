// ==========================================
// /start
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { saveSceneConfig } from "../../services/users.js";
import { getDateKey } from "../../services/time.js";
import { TIPS } from "../../config/messages.js";

export async function cmdStart({ env, ctx, token, chatId, uctx, userConfig, isGroupCtx, firstName, username, sceneKey }) {
  let dailyCount = 0;
  const todayStr = getDateKey(env);

  if (env.DB) {
    await saveSceneConfig(env, uctx, userConfig);
    const row = await env.DB.prepare(
      "SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?"
    ).bind(sceneKey, todayStr).first();
    dailyCount = row ? Number(row.count) || 0 : 0;
  }

  const limitStr = userConfig.maxDaily === -1 ? "无限制" : `${dailyCount}/${userConfig.maxDaily} 条`;
  const tag = isGroupCtx ? "👥 群聊成员（本群独立场景）" : "💬 私聊用户";

  const welcome = TIPS.WELCOME(firstName, username, tag, userConfig.points, limitStr, userConfig.lang);
  await sendAutoDelete(token, chatId, welcome, null, isGroupCtx, ctx);
}