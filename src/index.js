// ==========================================
// 🚀 Worker 入口
// ==========================================
import { resolveUserContext } from "./core/context.js";
import { handleCallback } from "./handlers/callback.js";
import { handleMessage } from "./handlers/message.js";
import { logError } from "./core/logger.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("已成功部署！", { status: 200 });
    }
    const token = env.BOT_TOKEN;
    const myId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID).trim() : null;
    if (!token) return new Response("Bot Token Missing", { status: 500 });

    try {
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
  }
};