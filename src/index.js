// ==========================================
// 🚀 Worker 入口
//
// fetch     —— Telegram Webhook 入口（POST 才处理，其它方法返回部署探活文案）
// scheduled —— Cron Triggers 入口（清理过期数据 + 给管理员发日报）
// ==========================================
import { resolveUserContext } from "./core/context.js";
import { handleCallback } from "./handlers/callback.js";
import { handleMessage } from "./handlers/message.js";
import { logError } from "./core/logger.js";
import { ensureSchema } from "./core/db.js";
import { runScheduledTasks } from "./services/daily.js";
import { syncCommandMenuOnce } from "./services/command-menu.js";

export default {
  /**
   * Webhook 入口。
   * 无论业务是否成功都返回 200，避免 Telegram 因 5xx 反复重推同一条更新；
   * 真正的异常会写入日志，方便 wrangler tail 排查。
   */
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

      // 命令菜单自检：内容变了才调用 Telegram（放进 waitUntil，不拖慢本次更新）
      const menuTask = syncCommandMenuOnce(env, token);
      if (ctx?.waitUntil) ctx.waitUntil(menuTask);

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
  /** 定时任务入口：先保证建表，再执行清理与日报推送 */
  async scheduled(event, env, ctx) {
    try {
      await ensureSchema(env);
      const task = runScheduledTasks(env, env.BOT_TOKEN, ctx);
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    } catch (e) {
      logError("定时任务运行异常:", e);
    }
  }
};
