// ==========================================
// 🖥️ Web 管理后台 · 数据接口（v3.10.2）
//
// 与 Telegram 侧的分工：这里只做「在聊天框里很别扭」的事 ——
// 搜索、批量看数据、导出、改几个字段。
// **权限与指令侧完全一致**：每个写操作先过 `can(role, capability)`，
// 而且危险动作尽量复用指令侧的既有函数（封禁 / 订单退款），不另写一套 SQL。
// ==========================================

import { can } from "../services/admins.js";
import { logAdminAction } from "../services/admin-log.js";
import { logPointChange } from "../services/points.js";
import { banUserById, unbanUserById, resolvePointTarget } from "../services/users.js";
import { FEATURES, getFeatureMap, setFeature } from "../services/features.js";
import { buildGroupScopeKey } from "../core/context.js";
import { formatAppTime } from "../services/time.js";
import { createRedeemCode, listRedeemCodes, setRedeemCodeEnabled } from "../services/redeem.js";
import { cancelOrderWithRefund, refundDoneOrder, getOrderById } from "../shop/actions.js";
import { deliveryText, deliveryOf } from "../shop/delivery.js";

const USERS_PER_PAGE = 20;
const ORDERS_PER_PAGE = 20;
const CODES_PER_PAGE = 20;
const GROUPS_PER_PAGE = 20;

/** 权限不足的统一返回（HTTP 200 + error 字段，前端按 error 提示） */
function forbidden(capability, label) {
  return { error: "forbidden", detail: `需要「${label || capability}」权限` };
}

/** 读 JSON 请求体（体积上限 4KB，后台不需要更大） */
export async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("请求体过大");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// ==========================================
// 📊 概览
// ==========================================

export async function apiOverview(env) {
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

  // 最近 7 天按天的 AI / 消息量，概览里画个迷你趋势
  const daily = await env.DB.prepare(`
    SELECT date_str,
           SUM(CASE WHEN metric = 'ai.call' THEN count ELSE 0 END) AS ai,
           SUM(CASE WHEN metric = 'msg.in' THEN count ELSE 0 END) AS msg
    FROM usage_stats WHERE date_str >= ?
    GROUP BY date_str ORDER BY date_str DESC
  `).bind(usageFrom).all();

  return {
    users: Number(users.results?.[0]?.n) || 0,
    blocked: Number(blocked.results?.[0]?.n) || 0,
    groups: Number(groups.results?.[0]?.n) || 0,
    points: Number(points.results?.[0]?.n) || 0,
    pendingOrders: Number(pendingOrders.results?.[0]?.n) || 0,
    reports: Number(reports.results?.[0]?.n) || 0,
    aiCall: usageMap["ai.call"] || 0,
    aiFail: usageMap["ai.fail"] || 0,
    msgIn: usageMap["msg.in"] || 0,
    daily: (daily.results || []).map((r) => ({
      date: r.date_str, ai: Number(r.ai) || 0, msg: Number(r.msg) || 0
    }))
  };
}

// ==========================================
// 👥 用户
// ==========================================

export async function apiUsers(env, url) {
  const q = String(url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * USERS_PER_PAGE;

  const where = q
    ? "WHERE s.first_name LIKE ? OR s.username LIKE ? OR s.user_id LIKE ? OR s.chat_id LIKE ?"
    : "";
  const like = `%${q}%`;
  const bindArgs = q ? [like, like, like, like] : [];

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM user_scenes s ${where}`).bind(...bindArgs),
    env.DB.prepare(`
      SELECT s.id, s.scene_key, s.chat_id, s.chat_type, s.user_id, s.username, s.first_name,
             s.max_daily, s.rate_limit_sec, s.updated_at,
             COALESCE(u.points, 0) AS points, COALESCE(u.blocked, 0) AS blocked
      FROM user_scenes s
      LEFT JOIN users u ON u.user_key = s.user_key
      ${where}
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...bindArgs, USERS_PER_PAGE, offset)
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
      maxDaily: Number(r.max_daily),
      rateLimitSec: Number(r.rate_limit_sec),
      blocked: Number(r.blocked) === 1,
      updatedAt: formatAppTime(env, r.updated_at)
    }))
  };
}

export async function apiBlockUser(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) return forbidden("manage_users", "用户管理");
  const body = await readJsonBody(request);
  const userId = String(body.userId || "").trim();
  const blocked = Boolean(body.blocked);
  if (!userId) return { error: "bad-request", detail: "缺少 userId" };

  // 复用指令侧同一条路径：内部会拒绝「封禁机器人管理员」这类危险操作，
  // 也会区分「真的解封了」和「本来就不在名单里」
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

export async function apiAdjustPoints(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) return forbidden("manage_users", "用户管理");
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

/** 改某个场景的额度 / 冷却（-1 = 不限额度，0 = 禁止使用） */
export async function apiUpdateScene(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) return forbidden("manage_users", "用户管理");
  const body = await readJsonBody(request);
  const sceneKey = String(body.sceneKey || "").trim();
  if (!sceneKey) return { error: "bad-request", detail: "缺少 sceneKey" };

  const maxDaily = Number.parseInt(body.maxDaily, 10);
  const rateLimitSec = Number.parseInt(body.rateLimitSec, 10);
  if (!Number.isInteger(maxDaily) && !Number.isInteger(rateLimitSec)) {
    return { error: "bad-request", detail: "没有要修改的字段" };
  }
  if (Number.isInteger(maxDaily) && (maxDaily < -1 || maxDaily > 100000)) {
    return { error: "bad-request", detail: "每日额度需在 -1 ~ 100000 之间（-1 = 不限）" };
  }
  if (Number.isInteger(rateLimitSec) && (rateLimitSec < 0 || rateLimitSec > 3600)) {
    return { error: "bad-request", detail: "冷却需在 0 ~ 3600 秒之间" };
  }

  const sets = [];
  const binds = [];
  if (Number.isInteger(maxDaily)) { sets.push("max_daily = ?"); binds.push(maxDaily); }
  if (Number.isInteger(rateLimitSec)) { sets.push("rate_limit_sec = ?"); binds.push(rateLimitSec); }
  binds.push(sceneKey);

  const res = await env.DB.prepare(
    `UPDATE user_scenes SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE scene_key = ?`
  ).bind(...binds).run();
  if (Number(res.meta?.changes) !== 1) return { error: "not-found", detail: "场景不存在" };

  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "mod_scene",
    detail: `${sceneKey} ${sets.join(", ")}`
  });
  return { ok: true };
}

/** 清空某个场景的对话记忆（连同长期记忆画像） */
export async function apiClearMemory(env, request, viewer) {
  if (!can(viewer.role, "manage_users")) return forbidden("manage_users", "用户管理");
  const body = await readJsonBody(request);
  const sceneKey = String(body.sceneKey || "").trim();
  if (!sceneKey) return { error: "bad-request", detail: "缺少 sceneKey" };

  const [hist] = await env.DB.batch([
    env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey),
    env.DB.prepare("DELETE FROM user_memory WHERE scene_key = ?").bind(sceneKey)
  ]);
  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "scene_clear_memory",
    detail: `${sceneKey}（删除 ${hist.meta?.changes || 0} 条，来自 Web 后台）`
  });
  return { ok: true };
}

// ==========================================
// 👥 群组与功能开关
// ==========================================

/** 群列表：每个群 + 它的群级开关状态 */
export async function apiGroups(env, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * GROUPS_PER_PAGE;

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(
      "SELECT COUNT(DISTINCT chat_id) AS n FROM user_scenes WHERE chat_type IN ('group','supergroup')"
    ),
    env.DB.prepare(`
      SELECT s.chat_id, MAX(s.updated_at) AS updated_at,
             COUNT(DISTINCT s.user_key) AS members
      FROM user_scenes s
      WHERE s.chat_type IN ('group','supergroup')
      GROUP BY s.chat_id
      ORDER BY MAX(s.updated_at) DESC
      LIMIT ? OFFSET ?
    `).bind(GROUPS_PER_PAGE, offset)
  ]);

  // 显式设置过的群级开关（没设置的跟随全局，不列出来避免误读成「已关」）
  const { results: overrides } = await env.DB.prepare(
    "SELECT scene_key, name, value FROM scene_settings WHERE scene_key LIKE 'group:%' AND name LIKE 'feature.%'"
  ).all();
  const overrideMap = {};
  for (const row of overrides || []) {
    const chatId = String(row.scene_key).slice("group:".length);
    // 只认纯群级键（`group:<id>`），成员级键 `group:<id>:user:<uid>` 不算
    if (chatId.includes(":")) continue;
    if (!overrideMap[chatId]) overrideMap[chatId] = {};
    overrideMap[chatId][String(row.name).slice("feature.".length)] = String(row.value) !== "off";
  }

  return {
    total: Number(countRes.results?.[0]?.n) || 0,
    page,
    pageSize: GROUPS_PER_PAGE,
    features: FEATURES.map((f) => ({ key: f.key, label: f.label })),
    rows: (listRes.results || []).map((r) => ({
      chatId: r.chat_id,
      members: Number(r.members) || 0,
      updatedAt: formatAppTime(env, r.updated_at),
      overrides: overrideMap[r.chat_id] || {}
    }))
  };
}

/** 切换某个群的群级功能开关 */
export async function apiToggleGroupFeature(env, request, viewer) {
  if (!can(viewer.role, "manage_features")) return forbidden("manage_features", "功能开关");
  const body = await readJsonBody(request);
  const chatId = String(body.chatId || "").trim();
  const feature = String(body.feature || "").trim();
  const enabled = Boolean(body.enabled);
  if (!chatId || !feature) return { error: "bad-request", detail: "缺少 chatId 或 feature" };

  const ok = await setFeature(env, buildGroupScopeKey(chatId), feature, enabled);
  if (!ok) return { error: "bad-request", detail: "未知的开关" };

  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "feature_toggle",
    detail: `群 ${chatId} ${feature} → ${enabled ? "开" : "关"}（来自 Web 后台）`
  });
  return { ok: true };
}

// ==========================================
// 🛒 商城
// ==========================================

export async function apiShopItems(env) {
  const { results } = await env.DB.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM shop_orders o WHERE o.item_id = i.id) AS sold
    FROM shop_items i ORDER BY i.id DESC LIMIT 200
  `).all();
  return {
    rows: (results || []).map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      price: Number(r.price) || 0,
      stock: Number(r.stock),
      category: r.category,
      delivery: deliveryOf(r),
      deliveryText: deliveryText(deliveryOf(r)),
      enabled: Number(r.enabled) === 1,
      sold: Number(r.sold) || 0
    }))
  };
}

/** 改价 / 改库存 / 上下架（只做字段级别的小改动，完整编辑仍在 Telegram 里） */
export async function apiUpdateShopItem(env, request, viewer) {
  if (!can(viewer.role, "manage_shop")) return forbidden("manage_shop", "商城管理");
  const body = await readJsonBody(request);
  const itemId = Number.parseInt(body.itemId, 10);
  if (!Number.isInteger(itemId)) return { error: "bad-request", detail: "缺少 itemId" };

  const item = await env.DB.prepare("SELECT * FROM shop_items WHERE id = ?").bind(itemId).first();
  if (!item) return { error: "not-found", detail: "商品不存在" };

  const sets = [];
  const binds = [];

  if (body.price !== undefined) {
    const price = Number.parseInt(body.price, 10);
    if (!Number.isInteger(price) || price < 0) return { error: "bad-request", detail: "价格必须是非负整数" };
    // 与 Telegram 侧同一条底线：售价不能低于「换积分」的兑换值，否则就是套利闭环
    if (item.use_type === "points" && Number(item.use_value) > price) {
      return {
        error: "bad-request",
        detail: `售价不能低于兑换值 ${item.use_value}（否则可以买来换积分套利）`
      };
    }
    sets.push("price = ?"); binds.push(price);
  }
  if (body.stock !== undefined) {
    const stock = Number.parseInt(body.stock, 10);
    if (!Number.isInteger(stock) || stock < -1) return { error: "bad-request", detail: "库存需为 -1（不限）或非负整数" };
    sets.push("stock = ?"); binds.push(stock);
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0);
  }
  if (sets.length === 0) return { error: "bad-request", detail: "没有要修改的字段" };

  binds.push(itemId);
  await env.DB.prepare(`UPDATE shop_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "shop_item_update",
    detail: `#${itemId} ${sets.join(", ")}（来自 Web 后台）`
  });
  return { ok: true };
}

export async function apiShopOrders(env, url) {
  const status = String(url.searchParams.get("status") || "pending");
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * ORDERS_PER_PAGE;

  const where = status === "all" ? "" : "WHERE status = ?";
  const binds = status === "all" ? [] : [status];

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM shop_orders ${where}`).bind(...binds),
    env.DB.prepare(`
      SELECT id, order_no, user_id, item_name, item_icon, price, status, remark, created_at
      FROM shop_orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?
    `).bind(...binds, ORDERS_PER_PAGE, offset)
  ]);

  return {
    total: Number(countRes.results?.[0]?.n) || 0,
    page,
    pageSize: ORDERS_PER_PAGE,
    rows: (listRes.results || []).map((r) => ({
      id: r.id,
      orderNo: r.order_no,
      userId: r.user_id,
      name: `${r.item_icon || "🎁"} ${r.item_name}`,
      price: Number(r.price) || 0,
      status: r.status,
      remark: r.remark || "",
      createdAt: formatAppTime(env, r.created_at)
    }))
  };
}

/**
 * 订单操作：done（标记完成）/ cancel（取消并退款）/ refund（已完成退款）。
 * 退款一律复用指令侧的 `cancelOrderWithRefund` / `refundDoneOrder`，
 * 它们已经把「收回背包物品、退积分、回滚库存、写订单日志」做全了。
 */
export async function apiShopOrderAction(env, request, viewer) {
  if (!can(viewer.role, "manage_shop")) return forbidden("manage_shop", "商城管理");
  const body = await readJsonBody(request);
  const orderId = Number.parseInt(body.orderId, 10);
  const action = String(body.action || "");
  if (!Number.isInteger(orderId)) return { error: "bad-request", detail: "缺少 orderId" };

  const order = await getOrderById(env, orderId);
  if (!order) return { error: "not-found", detail: "订单不存在" };

  if (action === "done") {
    if (order.status !== "pending") return { error: "bad-request", detail: "只有待处理订单可以标记完成" };
    await env.DB.prepare(
      "UPDATE shop_orders SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
    ).bind(orderId).run();
  } else if (action === "cancel") {
    if (order.status !== "pending") return { error: "bad-request", detail: "只有待处理订单可以取消退款" };
    const res = await cancelOrderWithRefund(env, order, "管理员取消（Web 后台）");
    if (res && res.ok === false) return { error: "failed", detail: res.error || "取消失败" };
  } else if (action === "refund") {
    if (order.status !== "done") return { error: "bad-request", detail: "只有已完成订单可以退款" };
    const res = await refundDoneOrder(env, order, "管理员退款（Web 后台）");
    if (res && res.ok === false) return { error: "failed", detail: res.error || "退款失败" };
  } else {
    return { error: "bad-request", detail: "未知的操作" };
  }

  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: `shop_order_${action}`,
    detail: `#${orderId} ${order.order_no}（来自 Web 后台）`
  });
  return { ok: true };
}

// ==========================================
// 🎟️ 兑换码
// ==========================================

export async function apiCodes(env, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const data = await listRedeemCodes(env, page, CODES_PER_PAGE);
  return {
    total: data.total,
    page: data.page,
    pageSize: CODES_PER_PAGE,
    rows: (data.rows || []).map((r) => ({
      id: r.id,
      code: r.code,
      points: Number(r.points) || 0,
      maxUses: Number(r.max_uses) || 1,
      usedCount: Number(r.used_count) || 0,
      enabled: Number(r.enabled) === 1,
      expiresAt: r.expires_at || "",
      createdAt: formatAppTime(env, r.created_at)
    }))
  };
}

export async function apiCreateCodes(env, request, viewer) {
  if (!can(viewer.role, "manage_codes")) return forbidden("manage_codes", "兑换码");
  const body = await readJsonBody(request);
  const points = Number.parseInt(body.points, 10);
  const count = Math.min(50, Math.max(1, Number.parseInt(body.count, 10) || 1));
  const validDays = Math.max(0, Number.parseInt(body.validDays, 10) || 0);
  const maxUses = Math.min(10000, Math.max(1, Number.parseInt(body.maxUses, 10) || 1));

  if (!Number.isInteger(points) || points <= 0) {
    return { error: "bad-request", detail: "积分必须是正整数" };
  }
  if (points > 1000000) return { error: "bad-request", detail: "单个兑换码积分过大" };

  const created = [];
  for (let i = 0; i < count; i++) {
    const code = await createRedeemCode(env, {
      points, maxUses, validDays, createdBy: `web:${viewer.userId}`
    });
    if (code?.code) created.push(code.code);
  }

  await logAdminAction(env, {
    adminId: `web:${viewer.userId}`, chatId: "web", action: "code_new",
    detail: `${points} 分 × ${created.length} 个（来自 Web 后台）`
  });
  return { ok: true, codes: created };
}

export async function apiToggleCode(env, request, viewer) {
  if (!can(viewer.role, "manage_codes")) return forbidden("manage_codes", "兑换码");
  const body = await readJsonBody(request);
  const codeId = Number.parseInt(body.codeId, 10);
  if (!Number.isInteger(codeId)) return { error: "bad-request", detail: "缺少 codeId" };
  const ok = await setRedeemCodeEnabled(env, codeId, Boolean(body.enabled));
  if (!ok) return { error: "failed", detail: "操作失败" };
  return { ok: true };
}

// ==========================================
// 📜 日志与导出
// ==========================================

const LOGS_PER_PAGE = 30;

export async function apiLogs(env, url) {
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

export async function apiExportUsersCsv(env) {
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
