// ==========================================
// 🔗 Webhook 自愈巡检（v3.4.0）
//
// 为什么需要它：2026-09-17 踩过一次「机器人完全没反应」的故障——
// Worker 正常、Token 正常、日志里一条错都没有，但 **Telegram 侧的 webhook
// 地址变成了空串**，所有更新因此无处投递。时间线显示它与 BotFather 撤销 /
// 更换 token 发生在同一时间窗；`wrangler deploy` 不会碰 webhook，
// 也就是说这类故障**不会留下任何日志**，只能靠主动查询发现。
//
// 做法：每 2 分钟的定时任务里顺带查一次 getWebhookInfo。
//   • 地址为空        → 用「期望地址」自动补回，并私聊告警（一次修复一条）
//   • 有投递错误      → 私聊告警（内容变了才提醒，避免每轮巡检刷屏）
//   • 地址非空但不同  → 保持不动（可能是你有意配的自定义域名 / 反代）
//   • 不知道该恢复成什么地址 → 什么都不做，只写日志
//
// 「期望地址」从哪来：
//   1. `env.WEBHOOK_URL`（显式配置，优先级最高）；
//   2. 上一次「带正确 secret_token 的请求」的 origin —— 只有 Telegram 知道这个
//      密钥，所以这个来源可信。**没配 WEBHOOK_SECRET 时不会记录**，否则谁都能
//      发一个伪造请求把 webhook 改到别处去。
// ==========================================

import { getWebhookInfo, setWebhook } from "../telegram/api.js";
import { getSetting, setSetting } from "./settings.js";
import { alertAdmin } from "./alerts.js";
import { logInfo, logWarn } from "../core/logger.js";

/** 记录「上一次收到更新的地址」，自愈时用它作为期望值 */
const URL_KEY = "webhook.url";
/** 记录「上一次告警过的投递错误」，避免同一件事反复提醒 */
const ERROR_KEY = "webhook.last_error";

/** 同一个 isolate 内的巡检间隔：2 分钟的 cron 不必每次都问 Telegram */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

let lastCheckAt = 0;
/** isolate 内缓存期望地址，避免每个请求都去读一次设置（null = 还没读过） */
let cachedExpected = null;

/** 只取「协议 + 主机」，丢掉 path / query：webhook 的容身之处就是一个 origin */
function normalizeOrigin(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

/** 配置里的 webhook 密钥（用于 setWebhook 的 secret_token） */
function secretOf(env) {
  return env?.WEBHOOK_SECRET ? String(env.WEBHOOK_SECRET).trim() : "";
}

/**
 * 期望的 webhook 地址：env.WEBHOOK_URL 优先，其次上一次登记下来的 origin。
 * @returns {Promise<string>} 空串表示「还不知道该恢复到哪」
 */
export async function expectedWebhookUrl(env) {
  const configured = normalizeOrigin(env?.WEBHOOK_URL);
  if (configured) return configured;
  if (cachedExpected === null) cachedExpected = await getSetting(env, URL_KEY, "");
  return cachedExpected || "";
}

/**
 * 收到 webhook 请求时登记来源地址。
 *
 * 只在请求确实通过了 secret 校验时登记：这个地址来自 Telegram，
 * 别人伪造不出来，所以可以放心地在自愈时拿它当目标。
 *
 * @param {object} env
 * @param {string} requestUrl 本次请求的 URL
 * @param {{verified?:boolean}} [opts] verified = 请求带了正确的 secret_token
 * @returns {Promise<string>} 登记后的期望地址（未登记则为空串）
 */
export async function noteIncomingWebhook(env, requestUrl, { verified = false } = {}) {
  if (!env?.DB) return "";
  // 显式配置优先：配了就以内个为准，不用记请求来源
  const configured = normalizeOrigin(env?.WEBHOOK_URL);
  if (configured) return configured;
  if (!verified) return await expectedWebhookUrl(env);

  const origin = normalizeOrigin(requestUrl);
  if (!origin) return "";
  if (cachedExpected === origin) return origin;

  cachedExpected = origin;
  await setSetting(env, URL_KEY, origin);
  logInfo("已登记 webhook 地址：", origin);
  return origin;
}

/**
 * 巡检并（必要时）自愈 webhook。
 *
 * @param {object} env
 * @param {string} token
 * @param {{force?:boolean, alert?:boolean}} [opts]
 *        force = true 跳过 isolate 节流；alert = false 只修不发告警（测试用）
 * @returns {Promise<{checked:boolean, url?:string, repaired?:boolean, error?:string, skipped?:string}>}
 */
export async function ensureWebhook(env, token, { force = false, alert = true } = {}) {
  if (!env?.DB || !token) return { checked: false, skipped: "缺少数据库或 Token" };

  const expected = await expectedWebhookUrl(env);
  if (!expected) return { checked: false, skipped: "还不知道该恢复到哪个地址" };

  if (!force) {
    const now = Date.now();
    if (now - lastCheckAt < CHECK_INTERVAL_MS) {
      return { checked: false, skipped: "距上次巡检不足 10 分钟" };
    }
    lastCheckAt = now;
  }

  const info = await getWebhookInfo(token);
  if (!info || info.ok === false) {
    const error = String(info?.description || info?.error?.description || "查询失败");
    logWarn("webhook 巡检失败：", error);
    return { checked: true, error };
  }

  const result = info.result || {};
  const current = String(result.url || "");

  // ---- 情况一：地址空了 → 自己补回来（就是这次踩的坑）----
  if (!current) {
    const res = await setWebhook(token, expected, { secretToken: secretOf(env) });
    const repaired = Boolean(res && res.ok !== false);
    logWarn("webhook 地址为空，自动恢复：", `${expected}（${repaired ? "成功" : "失败"}）`);
    if (repaired && alert) {
      await alertAdmin(env, token, {
        title: "Webhook 被清空，已自动恢复",
        detail: `已重新指向 ${expected}`,
        context: "自愈巡检"
      });
    }
    return {
      checked: true,
      url: expected,
      repaired,
      error: repaired ? undefined : String(res?.description || "恢复失败")
    };
  }

  // ---- 情况二：Telegram 投递失败 → 报给管理员（同一错误只报一次）----
  const lastError = String(result.last_error_message || "");
  if (lastError) {
    if ((await getSetting(env, ERROR_KEY, "")) !== lastError) {
      await setSetting(env, ERROR_KEY, lastError);
      logWarn("webhook 投递异常：", lastError);
      if (alert) {
        await alertAdmin(env, token, {
          title: "Webhook 投递异常",
          detail: lastError,
          context: current
        });
      }
    }
    return { checked: true, url: current, error: lastError };
  }
  if (await getSetting(env, ERROR_KEY, "")) await setSetting(env, ERROR_KEY, "");

  // ---- 情况三：地址不是期望值 → 保持不动，只写日志 ----
  if (current !== expected) {
    logInfo("webhook 地址与期望值不同（保持不动）：", `${current} ≠ ${expected}`);
  }
  return { checked: true, url: current };
}

/** 测试用：重置 isolate 内的节流与缓存 */
export function resetWebhookCache() {
  lastCheckAt = 0;
  cachedExpected = null;
}
