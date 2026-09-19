// ==========================================
// 🖥️ Web 管理后台（v3.10.0 起，v3.10.2 拆分为三个模块）
//
//   web/admin.js —— 登录、会话、路由（本文件）
//   web/api.js   —— 各接口的数据实现
//   web/pages.js —— 页面与样式
//
// 「无 Web 后台」原本是写在 README 的已知限制：改配置、翻日志、导出数据
// 都只能在 Telegram 的按钮菜单里点。这个模块把它补上，但**不另起一套权限**：
// 登录令牌只能由机器人管理员在 Telegram 里生成，每次请求都重新查一次角色，
// 所以后台永远不会比指令侧更能干。
//
// 路由（都挂在 /admin 下，和 webhook 的 POST / 互不干扰）：
//   GET  /admin                       → 单页后台（未登录时是说明页）
//   GET  /admin/api/overview          → 概览
//   GET  /admin/api/users             → 用户列表（可搜索）
//   POST /admin/api/users/{block,points,scene,clear-memory}
//   GET  /admin/api/groups            → 群列表 + 群级开关状态
//   POST /admin/api/groups/feature    → 切换某个群的功能开关
//   GET  /admin/api/shop/{items,orders}
//   POST /admin/api/shop/{item,order} → 改价 / 库存 / 上下架，订单完成 / 退款
//   GET  /admin/api/codes  · POST 同路径 = 批量生成
//   POST /admin/api/codes/toggle      → 启用 / 停用兑换码
//   GET  /admin/api/logs              → 审计日志
//   GET  /admin/export/users.csv      → 导出用户
// ==========================================

import { logError, logInfo } from "../core/logger.js";
import { getAdminRole } from "../services/admins.js";
import { escapeHtml } from "../utils/html.js";
import { sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";
import { expectedWebhookUrl } from "../services/webhook.js";
import {
  apiOverview, apiUsers, apiBlockUser, apiAdjustPoints, apiUpdateScene, apiClearMemory,
  apiGroups, apiToggleGroupFeature,
  apiShopItems, apiUpdateShopItem, apiShopOrders, apiShopOrderAction,
  apiCodes, apiCreateCodes, apiToggleCode,
  apiLogs, apiExportUsersCsv
} from "./api.js";
import { renderLoginPage, renderMessagePage, renderAdminPage } from "./pages.js";

const COOKIE_NAME = "tgbot_admin";
/** 登录态有效期（12 小时）：够用一天，又不用长期保存凭证 */
const SESSION_TTL_SEC = 12 * 3600;
/** 登录令牌本身的有效期 */
export const LOGIN_TTL_SEC = 5 * 60;
/**
 * 首次使用后，令牌还能再用多久（秒）。
 *
 * 为什么不是「用完即删」：Telegram 会为了生成链接预览去**抓取消息里的 URL**，
 * 那一次抓取同样打到 /admin?t=... 上，等于把一次性令牌当场消费掉 ——
 * 用户随后点开链接只会看到「链接无效」（线上实测表里一行都不剩）。
 * 现在改成「首次使用后把有效期收缩到 90 秒」：预览消耗掉的那次不影响用户点击，
 * 过了窗口又确实失效，仍然远小于原来 5 分钟的可利用时间。
 */
export const LOGIN_REUSE_WINDOW_SEC = 90;

// ==========================================
// 🔐 令牌与签名
// ==========================================

function randomHex(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 会话签名用的密钥：优先用 WEBHOOK_SECRET，没配就退回 Bot Token */
function sessionSecret(env) {
  return String(env?.WEBHOOK_SECRET || env?.BOT_TOKEN || "");
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(data)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定长比较，避免用 === 比较签名时泄漏时序信息 */
function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// ==========================================
// 🎫 登录令牌（Telegram 侧生成，Web 侧消费）
// ==========================================

/** 生成一枚登录令牌（只有机器人管理员能调用，见 cmdWeb） */
export async function createLoginToken(env, userId) {
  if (!env?.DB) return null;
  const token = randomHex(24);
  const expiresAt = Math.floor(Date.now() / 1000) + LOGIN_TTL_SEC;
  // 顺手清掉过期的，表不会随使用次数无限增长
  await env.DB.batch([
    env.DB.prepare("DELETE FROM web_login_tokens WHERE expires_at <= ?")
      .bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare("INSERT INTO web_login_tokens (token, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(token, String(userId), expiresAt)
  ]);
  return token;
}

/**
 * `/web` —— 生成登录链接。
 *
 * 只在**私聊**里响应：链接本身就是凭证，发在群里等于把它交给所有人。
 * 地址取自「配置的 WEBHOOK_URL」或「Telegram 侧登记过的 origin」，
 * 两者都没有时明确说清怎么补，而不是给一个打不开的链接。
 */
export async function cmdWeb({ env, token, chatId, uctx, isGroupCtx }) {
  if (isGroupCtx) {
    return sendMessage(token, chatId,
      "🖥️ Web 后台的登录链接是<b>凭证</b>，请到<b>私聊</b>里发送 <code>/web</code>。", "HTML");
  }
  if (!env?.DB) return sendMessage(token, chatId, "❌ 未绑定数据库，Web 后台不可用。");

  const origin = await expectedWebhookUrl(env);
  if (!origin) {
    return sendMessage(token, chatId,
      "⚠️ 还不知道这个 Worker 的网址，生成不了链接。\n\n" +
      "两种补法：\n" +
      "1. 在 <code>wrangler.production.toml</code> 的 <code>[vars]</code> 里填上 " +
      "<code>WEBHOOK_URL = \"https://你的-worker.workers.dev\"</code> 再部署；\n" +
      "2. 或者先给机器人发任意一条消息（webhook 自愈巡检会把地址记下来），再回来发 <code>/web</code>。",
      "HTML");
  }

  const loginToken = await createLoginToken(env, uctx.userId);
  if (!loginToken) return sendMessage(token, chatId, "❌ 生成登录链接失败，请稍后再试。");

  // ⚠️ 登录链接**只能放在按钮里**，正文里绝不要出现明文 URL：
  // Telegram 会为了生成预览去抓取正文里的链接，那一次抓取会把令牌消费掉，
  // 用户再点就只剩「链接无效」。同时显式关掉链接预览（双保险）。
  const url = `${origin}/admin?t=${loginToken}`;
  logInfo(`已生成 Web 后台登录链接（用户 ${uctx.userId}）`);

  return sendMessageWithKeyboard(
    token, chatId,
    `🖥️ <b>Web 管理后台</b>\n-------------------------\n` +
    `点下面的按钮打开（链接 <b>${Math.round(LOGIN_TTL_SEC / 60)} 分钟内有效</b>）。\n\n` +
    `可以看概览、搜用户、封禁 / 改积分、调限额、切群开关、管商品与订单、发兑换码、翻日志、导出 CSV。\n` +
    `权限与指令侧一致：你能在后台做什么，取决于你的角色。`,
    { inline_keyboard: [[{ text: "🖥️ 打开管理后台", url }]] },
    "HTML",
    { linkPreview: false }
  );
}

/**
 * 校验并「使用」登录令牌。
 * 首次使用把有效期收缩到 LOGIN_REUSE_WINDOW_SEC，过期就删掉。
 * @returns {Promise<string|null>} 通过则返回 user_id
 */
async function consumeLoginToken(env, token) {
  if (!env?.DB || !token) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at FROM web_login_tokens WHERE token = ?"
  ).bind(String(token)).first();
  if (!row) return null;

  const expiresAt = Number(row.expires_at) || 0;
  if (expiresAt < nowSec) {
    // 过期就顺手清掉，避免表里堆着没用的行
    await env.DB.prepare("DELETE FROM web_login_tokens WHERE token = ?").bind(String(token)).run();
    return null;
  }

  // 收缩有效期（更新失败不该挡住登录，宽容处理）
  try {
    const nextExpiry = Math.min(expiresAt, nowSec + LOGIN_REUSE_WINDOW_SEC);
    if (nextExpiry !== expiresAt) {
      await env.DB.prepare("UPDATE web_login_tokens SET expires_at = ? WHERE token = ?")
        .bind(nextExpiry, String(token)).run();
    }
  } catch (e) {
    logError("收缩登录令牌有效期失败（本次仍放行）：", e);
  }

  return String(row.user_id);
}

// ==========================================
// 🍪 会话
// ==========================================

async function issueSession(env, userId) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await hmacHex(sessionSecret(env), `${userId}.${expires}`);
  return `${userId}.${expires}.${sig}`;
}

/**
 * 读会话并**当场复核角色**：cookie 有效不代表还是管理员
 * （授权随时可能被撤销，不能在 cookie 里把身份「定格」12 小时）。
 */
async function resolveViewer(env, request) {
  const raw = parseCookies(request.headers.get("Cookie"))[COOKIE_NAME];
  if (!raw) return null;
  const parts = String(raw).split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts;
  if (!userId || !expires) return null;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return null;

  const expect = await hmacHex(sessionSecret(env), `${userId}.${expires}`);
  if (!safeEqual(expect, sig)) return null;

  const ownerId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID).trim() : null;
  const role = await getAdminRole(env, userId, { ownerId });
  if (!role) return null;
  return { userId, role, ownerId };
}

// ==========================================
// 🧭 路由
// ==========================================

/** JSON 响应（统一 no-store：后台数据不该被中间层缓存） */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

/**
 * Web 后台总入口。
 * @returns {Promise<Response>}
 */
export async function handleWebAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const isPost = request.method === "POST";

  if (!env?.DB) return html(renderMessagePage("未绑定数据库", "这个部署没有绑定 D1，Web 后台不可用。"), 503);
  if (!sessionSecret(env)) {
    return html(renderMessagePage("缺少密钥", "请至少配置 BOT_TOKEN（或 WEBHOOK_SECRET）后再使用后台。"), 503);
  }

  // ---------- 登录：用令牌换 cookie ----------
  const tokenParam = url.searchParams.get("t");
  if (tokenParam) {
    const userId = await consumeLoginToken(env, tokenParam);
    if (!userId) {
      return html(renderMessagePage(
        "登录链接无效",
        "链接已过期。请在 Telegram 里重新发送 /web 获取新的登录按钮。"
      ), 401);
    }
    const cookie = await issueSession(env, userId);
    return new Response(null, {
      status: 302,
      headers: {
        location: "/admin",
        "set-cookie": `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}`,
        "cache-control": "no-store"
      }
    });
  }

  if (isPost && path === "/admin/logout") {
    return new Response(null, {
      status: 302,
      headers: {
        location: "/admin",
        "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      }
    });
  }

  const viewer = await resolveViewer(env, request);

  // ---------- 未登录 ----------
  if (!viewer) {
    if (path.startsWith("/admin/api/") || path.startsWith("/admin/export/")) {
      return json({ error: "unauthorized" }, 401);
    }
    return html(renderLoginPage());
  }

  // ---------- 已登录 ----------
  try {
    if (path === "/admin") return html(renderAdminPage(viewer));

    if (path === "/admin/api/overview") return json(await apiOverview(env));
    if (path === "/admin/api/users") return json(await apiUsers(env, url));

    if (path === "/admin/api/users/block" && isPost) return json(await apiBlockUser(env, request, viewer));
    if (path === "/admin/api/users/points" && isPost) return json(await apiAdjustPoints(env, request, viewer));
    if (path === "/admin/api/users/scene" && isPost) return json(await apiUpdateScene(env, request, viewer));
    if (path === "/admin/api/users/clear-memory" && isPost) return json(await apiClearMemory(env, request, viewer));

    if (path === "/admin/api/groups") return json(await apiGroups(env, url));
    if (path === "/admin/api/groups/feature" && isPost) return json(await apiToggleGroupFeature(env, request, viewer));

    if (path === "/admin/api/shop/items") return json(await apiShopItems(env));
    if (path === "/admin/api/shop/item" && isPost) return json(await apiUpdateShopItem(env, request, viewer));
    if (path === "/admin/api/shop/orders") return json(await apiShopOrders(env, url));
    if (path === "/admin/api/shop/order" && isPost) return json(await apiShopOrderAction(env, request, viewer));

    if (path === "/admin/api/codes") {
      return json(isPost ? await apiCreateCodes(env, request, viewer) : await apiCodes(env, url));
    }
    if (path === "/admin/api/codes/toggle" && isPost) return json(await apiToggleCode(env, request, viewer));

    if (path === "/admin/api/logs") return json(await apiLogs(env, url));
    if (path === "/admin/export/users.csv") return await apiExportUsersCsv(env);

    return json({ error: "not-found" }, 404);
  } catch (e) {
    logError("Web 后台请求失败：", e);
    return json({ error: "server-error", detail: String(e?.message || e) }, 500);
  }
}

// CSV 转义在 api.js 里，这里再导出一次：测试与调用方用 `web/admin.js` 作入口更自然
export { csvCell } from "./api.js";
