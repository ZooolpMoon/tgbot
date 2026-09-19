// ==========================================
// 🖥️ Web 管理后台（v3.10.0）
//
// 「无 Web 后台」原本是写在 README 的已知限制：改配置、翻日志、导出数据
// 都只能在 Telegram 的按钮菜单里点。这个模块把它补上，但**不另起一套权限**：
// 登录令牌只能由机器人管理员在 Telegram 里生成，每次请求都重新查一次角色，
// 所以后台永远不会比指令侧更能干。
//
// 路由（都挂在 /admin 下，和 webhook 的 POST / 互不干扰）：
//   GET  /admin                      → 单页后台（未登录时是说明页）
//   GET  /admin/api/overview         → 概览数字
//   GET  /admin/api/users?q=&page=   → 用户列表
//   POST /admin/api/users/block      → 封禁 / 解封
//   POST /admin/api/users/points     → 增减积分
//   GET  /admin/api/logs?page=       → 操作日志
//   GET  /admin/export/users.csv     → 导出用户（Excel 友好）
//
// 登录方式见 core/db.js 里 web_login_tokens 的说明（一次性令牌，不是 Login Widget）。
// ==========================================

import { logError } from "../core/logger.js";
import { can, getAdminRole, roleLabel } from "../services/admins.js";
import { escapeHtml } from "../utils/html.js";
import { logAdminAction } from "../services/admin-log.js";
import { banUserById, unbanUserById, resolvePointTarget } from "../services/users.js";
import { logPointChange } from "../services/points.js";
import { formatAppTime } from "../services/time.js";
import { sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";
import { logInfo } from "../core/logger.js";
import { expectedWebhookUrl } from "../services/webhook.js";

const COOKIE_NAME = "tgbot_admin";
/** 登录态有效期（12 小时）：够用一天，又不用长期保存凭证 */
const SESSION_TTL_SEC = 12 * 3600;
/** 一次性登录令牌有效期 */
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

/** 生成一枚一次性登录令牌（只有机器人管理员能调用，见 cmdWeb） */
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
 * `/web` —— 生成一次性登录链接。
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
    `登录后可看概览、搜用户、封禁 / 解封、改积分、翻审计日志、导出 CSV。\n` +
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

  if (!env?.DB) return html(renderMessagePage("未绑定数据库", "这个部署没有绑定 D1，Web 后台不可用。"), 503);
  if (!sessionSecret(env)) {
    return html(renderMessagePage("缺少密钥", "请至少配置 BOT_TOKEN（或 WEBHOOK_SECRET）后再使用后台。"), 503);
  }

  // ---------- 登录：用一次性令牌换 cookie ----------
  const tokenParam = url.searchParams.get("t");
  if (tokenParam) {
    const userId = await consumeLoginToken(env, tokenParam);
    if (!userId) {
      return html(renderMessagePage(
        "登录链接无效",
        "链接已过期或已被使用。请在 Telegram 里重新发送 /web 获取新的链接。"
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

  if (request.method === "POST" && path === "/admin/logout") {
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
    if (path === "/admin/api/users/block") return json(await apiBlockUser(env, request, viewer));
    if (path === "/admin/api/users/points") return json(await apiAdjustPoints(env, request, viewer));
    if (path === "/admin/api/logs") return json(await apiLogs(env, url));
    if (path === "/admin/export/users.csv") return await apiExportUsersCsv(env);
    return json({ error: "not-found" }, 404);
  } catch (e) {
    logError("Web 后台请求失败：", e);
    return json({ error: "server-error", detail: String(e?.message || e) }, 500);
  }
}

// ==========================================
// 📊 API 实现
// ==========================================

async function apiOverview(env) {
  const [users, blocked, groups, points, pendingOrders, reports] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(blocked, 0) = 1"),
    env.DB.prepare("SELECT COUNT(DISTINCT chat_id) AS n FROM user_scenes WHERE chat_type IN ('group','supergroup')"),
    env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS n FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'pending'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM group_daily_reports")
  ]);

  const usageFrom = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const usage = await env.DB.prepare(
    "SELECT metric, SUM(count) AS n FROM usage_stats WHERE date_str >= ? GROUP BY metric"
  ).bind(usageFrom).all();

  const usageMap = {};
  for (const row of usage.results || []) usageMap[row.metric] = Number(row.n) || 0;

  return {
    users: Number(users.results?.[0]?.n) || 0,
    blocked: Number(blocked.results?.[0]?.n) || 0,
    groups: Number(groups.results?.[0]?.n) || 0,
    points: Number(points.results?.[0]?.n) || 0,
    pendingOrders: Number(pendingOrders.results?.[0]?.n) || 0,
    reports: Number(reports.results?.[0]?.n) || 0,
    aiCall: usageMap["ai.call"] || 0,
    aiFail: usageMap["ai.fail"] || 0,
    msgIn: usageMap["msg.in"] || 0
  };
}

const USERS_PER_PAGE = 20;

async function apiUsers(env, url) {
  const q = String(url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * USERS_PER_PAGE;

  const where = q
    ? "WHERE s.first_name LIKE ? OR s.username LIKE ? OR s.user_id LIKE ? OR s.chat_id LIKE ?"
    : "";
  const like = `%${q}%`;
  const bindArgs = q ? [like, like, like, like] : [];

  const countSql = `SELECT COUNT(*) AS n FROM user_scenes s ${where}`;
  const listSql = `
    SELECT s.id, s.scene_key, s.chat_id, s.chat_type, s.user_id, s.username, s.first_name,
           s.max_daily, s.updated_at, COALESCE(u.points, 0) AS points,
           COALESCE(u.blocked, 0) AS blocked
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    ${where}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `;

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(countSql).bind(...bindArgs),
    env.DB.prepare(listSql).bind(...bindArgs, USERS_PER_PAGE, offset)
  ]);

  return {
    total: Number(countRes.results?.[0]?.n) || 0,
    page,
    pageSize: USERS_PER_PAGE,
    rows: (listRes.results || []).map((r) => ({
      sceneKey: r.scene_key,
      chatId: r.chat_id,
      chatType: r.chat_type,
      userId: r.user_id,
      username: r.username,
      firstName: r.first_name,
      points: Number(r.points) || 0,
      blocked: Number(r.blocked) === 1,
      updatedAt: r.updated_at
    }))
  };
}

/** 读 JSON 请求体（体积上限 4KB，后台不需要更大） */
async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("请求体过大");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function apiBlockUser(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) {
    return { error: "forbidden", detail: "需要「用户管理」权限" };
  }
  const body = await readJsonBody(request);
  const userId = String(body.userId || "").trim();
  const blocked = Boolean(body.blocked);
  if (!userId) return { error: "bad-request", detail: "缺少 userId" };

  // 复用指令侧同一条路径：内部会拒绝「封禁机器人管理员」这类危险操作，
  // 也会区分「真的解封了」和「本来就不在名单里」（见 unbanUserById 的注释）
  const res = blocked
    ? await banUserById(env, userId, { createdBy: `web:${viewer.userId}` })
    : await unbanUserById(env, userId);
  if (!res?.ok) return { error: "failed", detail: res?.error || "操作失败" };

  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web",
    action: blocked ? "user_block" : "user_unblock",
    detail: `${userId}（来自 Web 后台）`
  });
  return { ok: true };
}

async function apiAdjustPoints(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) {
    return { error: "forbidden", detail: "需要「用户管理」权限" };
  }
  const body = await readJsonBody(request);
  const delta = Math.trunc(Number(body.delta));
  if (!Number.isFinite(delta) || delta === 0) {
    return { error: "bad-request", detail: "积分变动必须是非 0 的整数" };
  }
  const target = await resolvePointTarget(env, String(body.target || "").trim());
  if (!target?.userKey) {
    return {
      error: "bad-request",
      detail: String(target?.error || "找不到这个用户").replace(/<[^>]+>/g, "") +
        "（可用场景 ID / 用户 ID / @用户名）"
    };
  }

  const res = await env.DB.prepare(
    "UPDATE users SET points = MAX(0, points + ?), updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(delta, target.userKey).first();
  if (!res) return { error: "failed", detail: "更新失败" };

  const balance = Number(res.points) || 0;
  await logPointChange(env, target.userKey, delta, balance, "管理员调整（Web 后台）");
  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "mod_points",
    detail: `${target.userKey} ${delta > 0 ? "+" : ""}${delta} → ${balance}`
  });
  return { ok: true, balance };
}

const LOGS_PER_PAGE = 30;

async function apiLogs(env, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * LOGS_PER_PAGE;
  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM admin_logs"),
    env.DB.prepare(
      "SELECT id, admin_id, action, detail, created_at FROM admin_logs ORDER BY id DESC LIMIT ? OFFSET ?"
    ).bind(LOGS_PER_PAGE, offset)
  ]);
  return {
    total: Number(countRes.results?.[0]?.n) || 0,
    page,
    pageSize: LOGS_PER_PAGE,
    rows: (listRes.results || []).map((r) => ({
      id: r.id,
      adminId: r.admin_id,
      action: r.action,
      detail: r.detail,
      createdAt: formatAppTime(env, r.created_at)
    }))
  };
}

/** CSV 字段转义：逗号 / 引号 / 换行都必须包引号 */
export function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function apiExportUsersCsv(env) {
  const { results } = await env.DB.prepare(`
    SELECT s.user_id, s.username, s.first_name, s.chat_type, s.chat_id,
           COALESCE(u.points, 0) AS points, COALESCE(u.blocked, 0) AS blocked, s.updated_at
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    ORDER BY s.updated_at DESC
    LIMIT 5000
  `).all();

  const header = "用户ID,用户名,昵称,场景类型,群ID,积分,是否封禁,最后活跃";
  const lines = [header];
  for (const r of results || []) {
    lines.push([
      r.user_id, r.username, r.first_name, r.chat_type, r.chat_id,
      Number(r.points) || 0, Number(r.blocked) === 1 ? "是" : "否",
      formatAppTime(env, r.updated_at)
    ].map(csvCell).join(","));
  }

  // 加 BOM：否则 Excel 打开中文会乱码
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tgbot-users-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store"
    }
  });
}

// ==========================================
// 🖼️ 页面
// ==========================================

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a1f;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2f36;--accent:#60a5fa;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--card)}
header h1{font-size:16px;margin:0;font-weight:600}
nav a{color:var(--muted);text-decoration:none;margin-right:12px;font-size:13px;cursor:pointer}
nav a.on{color:var(--accent);font-weight:600}
main{padding:20px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--muted);font-size:12px}
.card .v{font-size:20px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px}
tr:last-child td{border-bottom:none}
input,button,select{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:transparent}
button.danger{color:var(--danger);border-color:currentColor}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.muted{color:var(--muted);font-size:12px}
.empty{padding:30px;text-align:center;color:var(--muted)}
.err{color:var(--danger);font-size:12px}
`;

function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要登录 · 机器人后台</title><style>${BASE_CSS}</style></head>
<body><main>
<div class="card">
<h1 style="margin-top:0">🔐 需要登录</h1>
<p>这个后台只认 Telegram 里发出的<b>一次性登录链接</b>，没有密码可输。</p>
<p>打开 Telegram，在私聊里给机器人发送：</p>
<p><code>/web</code></p>
<p class="muted">机器人会回一条 5 分钟内有效的链接（用过即失效）。只有已授权的管理员才能生成。</p>
</div>
</main></body></html>`;
}

function renderMessagePage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head>
<body><main><div class="card"><h1 style="margin-top:0">${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p></div></main></body></html>`;
}

/**
 * 单页后台。刻意做成「一页 + 原生 fetch」：
 * 没有构建步骤、没有外部 CDN，部署上去就能用，也不会因为前端依赖过期而烂掉。
 */
function renderAdminPage(viewer) {
  const roleName = escapeHtml(roleLabel(viewer.role));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>机器人后台</title><style>${BASE_CSS}</style></head>
<body>
<header>
  <h1>🖥️ 机器人后台</h1>
  <nav>
    <a data-tab="overview" class="on">概览</a>
    <a data-tab="users">用户</a>
    <a data-tab="logs">日志</a>
  </nav>
  <span class="muted" style="margin-left:auto">${roleName} · <code>${escapeHtml(viewer.userId)}</code></span>
  <form method="post" action="/admin/logout" style="margin:0"><button type="submit">退出</button></form>
</header>
<main>
  <section id="tab-overview"></section>
  <section id="tab-users" hidden></section>
  <section id="tab-logs" hidden></section>
</main>
<script>
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options));
  if (res.status === 401) { location.href = "/admin"; return null; }
  return res.json();
}

const fmt = (n) => new Intl.NumberFormat("zh-CN").format(Number(n) || 0);

// ---------- 概览 ----------
async function renderOverview() {
  const d = await api("/admin/api/overview");
  if (!d) return;
  const cards = [
    ["用户", fmt(d.users)], ["群组", fmt(d.groups)], ["积分总量", fmt(d.points)],
    ["已封禁", fmt(d.blocked)], ["待处理订单", fmt(d.pendingOrders)],
    ["近 7 天 AI 调用", fmt(d.aiCall)], ["近 7 天模型失败", fmt(d.aiFail)], ["近 7 天群消息", fmt(d.msgIn)]
  ];
  $("#tab-overview").innerHTML =
    '<div class="cards">' + cards.map(([k, v]) =>
      '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'
    ).join("") + '</div>' +
    '<div class="row"><a href="/admin/export/users.csv"><button class="primary">⬇️ 导出用户 CSV</button></a>' +
    '<span class="muted">导出最多 5000 行，含积分与封禁状态</span></div>';
}

// ---------- 用户 ----------
let userQuery = "";
async function renderUsers(page) {
  const d = await api("/admin/api/users?q=" + encodeURIComponent(userQuery) + "&page=" + (page || 1));
  if (!d) return;
  const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const rows = d.rows.map((u) => {
    const name = u.firstName || u.username || u.userId || "(未命名)";
    const kind = u.chatType === "private" ? "私聊" : "群";
    return '<tr>' +
      '<td>' + esc(name) + '<div class="muted">' + esc(u.userId || "") + '</div></td>' +
      '<td>' + esc(kind + " " + (u.chatId || "")) + '</td>' +
      '<td>' + fmt(u.points) + '</td>' +
      '<td>' + (u.blocked ? '<span class="err">已封禁</span>' : "正常") + '</td>' +
      '<td>' + esc(u.updatedAt || "") + '</td>' +
      '<td>' +
        '<button data-block="' + esc(u.userId || "") + '" data-next="' + (u.blocked ? "0" : "1") + '" class="' + (u.blocked ? "" : "danger") + '">' + (u.blocked ? "解封" : "封禁") + '</button> ' +
        '<button data-points="' + esc(u.userId || "") + '">改积分</button>' +
      '</td></tr>';
  }).join("");

  $("#tab-users").innerHTML =
    '<div class="row"><input id="q" placeholder="搜索昵称 / 用户名 / 用户ID / 群ID" value="' + esc(userQuery) + '" style="min-width:260px">' +
    '<button class="primary" id="search">搜索</button>' +
    '<span class="muted">共 ' + fmt(d.total) + ' 条</span></div>' +
    '<table><thead><tr><th>用户</th><th>场景</th><th>积分</th><th>状态</th><th>最后活跃</th><th>操作</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="6" class="empty">没有匹配的记录</td></tr>') + '</tbody></table>' +
    '<div class="row" style="margin-top:12px"><button id="prev"' + (page <= 1 ? " disabled" : "") + '>← 上一页</button>' +
    '<span class="muted">第 ' + page + ' / ' + totalPages + ' 页</span>' +
    '<button id="next"' + (page >= totalPages ? " disabled" : "") + '>下一页 →</button></div>';

  $("#search").onclick = () => { userQuery = $("#q").value.trim(); renderUsers(1); };
  $("#q").onkeydown = (e) => { if (e.key === "Enter") { userQuery = $("#q").value.trim(); renderUsers(1); } };
  const prev = $("#prev"), next = $("#next");
  if (prev) prev.onclick = () => renderUsers(page - 1);
  if (next) next.onclick = () => renderUsers(page + 1);

  document.querySelectorAll("[data-block]").forEach((btn) => {
    btn.onclick = async () => {
      const userId = btn.getAttribute("data-block");
      const blocked = btn.getAttribute("data-next") === "1";
      if (blocked && !confirm("确认封禁 " + userId + " ？（该用户在所有场景都会被拦下）")) return;
      const r = await api("/admin/api/users/block", { method: "POST", body: JSON.stringify({ userId, blocked }) });
      if (r && r.ok) renderUsers(page); else alert((r && r.detail) || "操作失败");
    };
  });
  document.querySelectorAll("[data-points]").forEach((btn) => {
    btn.onclick = async () => {
      const target = btn.getAttribute("data-points");
      const delta = prompt("给 " + target + " 增减多少积分？（可为负数）", "10");
      if (delta === null) return;
      const r = await api("/admin/api/users/points", { method: "POST", body: JSON.stringify({ target, delta: Number(delta) }) });
      if (r && r.ok) { alert("已更新，当前余额 " + r.balance); renderUsers(page); }
      else alert((r && r.detail) || "操作失败");
    };
  });
}

// ---------- 日志 ----------
async function renderLogs(page) {
  const d = await api("/admin/api/logs?page=" + (page || 1));
  if (!d) return;
  const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const rows = d.rows.map((l) =>
    '<tr><td class="muted">' + esc(l.createdAt) + '</td><td><code>' + esc(l.adminId) + '</code></td>' +
    '<td>' + esc(l.action) + '</td><td>' + esc(l.detail) + '</td></tr>'
  ).join("");

  $("#tab-logs").innerHTML =
    '<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="4" class="empty">还没有日志</td></tr>') + '</tbody></table>' +
    '<div class="row" style="margin-top:12px"><button id="lprev"' + (page <= 1 ? " disabled" : "") + '>← 上一页</button>' +
    '<span class="muted">第 ' + page + ' / ' + totalPages + ' 页</span>' +
    '<button id="lnext"' + (page >= totalPages ? " disabled" : "") + '>下一页 →</button></div>';

  const prev = $("#lprev"), next = $("#lnext");
  if (prev) prev.onclick = () => renderLogs(page - 1);
  if (next) next.onclick = () => renderLogs(page + 1);
}

// ---------- 标签切换 ----------
const renderers = { overview: renderOverview, users: () => renderUsers(1), logs: () => renderLogs(1) };
function switchTab(name) {
  for (const key of Object.keys(renderers)) {
    $("#tab-" + key).hidden = key !== name;
    const link = document.querySelector('[data-tab="' + key + '"]');
    if (link) link.classList.toggle("on", key === name);
  }
  renderers[name]();
}
document.querySelectorAll("[data-tab]").forEach((a) => {
  a.onclick = () => switchTab(a.getAttribute("data-tab"));
});
switchTab("overview");
</script>
</body></html>`;
}
