// ==========================================
// 🚀 Worker 入口
// ==========================================
import { resolveUserContext } from "./core/context.js";
import { handleCallback } from "./handlers/callback.js";
import { handleMessage } from "./handlers/message.js";
import { logError } from "./core/logger.js";
import { ensureSchema } from "./core/db.js";
import { runScheduledTasks } from "./services/daily.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("已成功部署！", { status: 200 });
    }

    // 可选安全校验：如果配置了 WEBHOOK_SECRET，则必须匹配 Telegram 回传的 secret token。
    const webhookSecret = env.WEBHOOK_SECRET ? String(env.WEBHOOK_SECRET).trim() : "";
    if (webhookSecret) {
      const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (header !== webhookSecret) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const token = env.BOT_TOKEN;
    const myId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID).trim() : null;
    if (!token) return new Response("Bot Token Missing", { status: 500 });

    try {
      // 首次请求时自动建表（IF NOT EXISTS，幂等，不破坏已有数据）
      await ensureSchema(env);
      const payload = await request.json();
      const uctx = resolveUserContext(payload);
      if (!uctx) return new Response("OK", { status: 200 });
      const isGroupCtx = uctx.chatType === "group" || uctx.chatType === "supergroup";

      if (payload.callback_query) {
        await handleCallback({ env, ctx, token, myId, uctx, payload });
        return new Response("OK", { status: 200 });
      }
      if (payload.message || payload.edited_message) {
        await handleMessage({ env, ctx, token, myId, uctx, payload, isGroupCtx });
        return new Response("OK", { status: 200 });
      }
      return new Response("OK", { status: 200 });
    } catch (e) {
      logError("Worker 运行异常:", e);
      return new Response("OK", { status: 200 });
    }
  },

  // 定时任务（Cron Triggers）：清理过期数据 + 推送每日概况
  async scheduled(event, env, ctx) {
    try {
      await ensureSchema(env);
      const task = runScheduledTasks(env, env.BOT_TOKEN);
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    } catch (e) {
      logError("定时任务运行异常:", e);
    }
  }
};
