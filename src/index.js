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
import { noteIncomingWebhook } from "./services/webhook.js";
import { alertAdmin } from "./services/alerts.js";

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
    let verifiedBySecret = false;
    if (webhookSecret) {
      const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (header !== webhookSecret) {
        return new Response("Unauthorized", { status: 401 });
      }
      verifiedBySecret = true;
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

      // 登记本次请求的地址，供 webhook 自愈巡检当「期望值」用
      // （只有通过 secret 校验的请求才作数，见 services/webhook.js）
      const noteTask = noteIncomingWebhook(env, request.url, { verified: verifiedBySecret });
      if (ctx?.waitUntil) ctx.waitUntil(noteTask);

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
      // 顺手私聊管理员（同类错误 5 分钟只提醒一次，失败静默）
      if (ctx?.waitUntil) ctx.waitUntil(alertAdmin(env, token, { title: "Worker 运行异常", detail: e?.message || String(e) }));
      return new Response("OK", { status: 200 });
    }
  },

  // 定时任务（Cron Triggers）：清理过期数据 + 推送每日概况
  /**
   * 定时任务入口：先保证建表，再执行清理与日报推送。
   * event.cron 要传下去——只有「每天一次」的那条 cron 负责推每日概况，
   * 每 2 分钟的兜底 cron 只做清理与长延时删除（否则概况会每 2 分钟弹一次）。
   */
  async scheduled(event, env, ctx) {
    try {
      await ensureSchema(env);
      const task = runScheduledTasks(env, env.BOT_TOKEN, ctx, { cron: event?.cron || null });
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    } catch (e) {
      logError("定时任务运行异常:", e);
      await alertAdmin(env, env.BOT_TOKEN, { title: "定时任务异常", detail: e?.message || String(e) });
    }
  }
};
