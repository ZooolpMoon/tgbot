// ==========================================
// 👑 管理员与角色（v3.0.0）
//
// 三种身份，权限从高到低：
//   owner      —— 环境变量 MY_TELEGRAM_ID，永远是最高权限（不进 bot_admins 表）
//   admin      —— 除「权限管理」外的全部后台能力
//   moderator  —— 只能做群规执法（封禁 / 踢出 / 禁言 / 群规查看 / 处理举报与申诉）
//
// 权限用「能力（capability）」表达，命令注册表与回调路由都按能力判定，
// 这样以后新增模块只要挂一个能力名，不用再改权限判定。
// ==========================================

import { logError } from "../core/logger.js";

// ==========================================
// 角色缓存（isolate 级，60 秒）
// 每条群消息都要判一次权限，直接查库太浪费；admins 表很小、变更很少，
// 60 秒的延迟对「刚授权就要生效」来说可以接受（面板操作后也会主动清缓存）。
// ==========================================
const CACHE_TTL_MS = 60 * 1000;
const ROLE_CACHE = new Map();

/** 清掉角色缓存（授权 / 移除 / 改角色后调用） */
export function clearAdminCache() {
  ROLE_CACHE.clear();
}

/** 角色定义（顺序即显示顺序） */
export const ROLES = {
  owner: { key: "owner", label: "👑 拥有者", desc: "最高权限：含管理员与权限管理" },
  admin: { key: "admin", label: "🛡️ 管理员", desc: "除权限管理外的全部后台能力" },
  moderator: { key: "moderator", label: "⚔️ 执法员", desc: "只能做群规执法与处置记录查看" }
};

/** 表里能存的两个角色（owner 由环境变量决定） */
export const ASSIGNABLE_ROLES = ["admin", "moderator"];

/** 能力定义（面板上用来解释「这个角色能做什么」） */
export const CAPABILITIES = {
  manage_admins: "管理员与权限管理",
  manage_users: "用户管理（积分 / 限额 / 频率 / 封禁 / 删除场景）",
  manage_shop: "商城管理（商品 / 订单）",
  manage_kb: "知识库管理",
  manage_guard: "群规执法配置（群规 / 默认处置 / 预警）",
  manage_features: "功能开关与指令菜单",
  manage_autodelete: "消息自动删除设置",
  manage_codes: "兑换码",
  broadcast: "群发通知",
  view_logs: "查看操作日志",
  view_stats: "查看运行状态与统计",
  enforce: "群规执法（封禁 / 踢出 / 禁言 / 处理举报）"
};

/** 角色 → 能力集合；owner 用 "*" 表示全部 */
const ROLE_CAPABILITIES = {
  owner: ["*"],
  admin: [
    "manage_users", "manage_shop", "manage_kb", "manage_guard", "manage_features",
    "manage_autodelete", "manage_codes", "broadcast", "view_logs", "view_stats", "enforce"
  ],
  moderator: ["enforce"]
};

/** 角色中文名（未知角色原样返回） */
export function roleLabel(role) {
  return ROLES[String(role || "")]?.label || String(role || "无权限");
}

/** 某个角色是否具备某能力 */
export function can(role, capability) {
  const caps = ROLE_CAPABILITIES[String(role || "")];
  if (!caps) return false;
  if (caps.includes("*")) return true;
  return caps.includes(String(capability || ""));
}

/** 角色是否算「管理员」（能进后台）——执法员不算进后台，但能用执法指令 */
export function isBackstageRole(role) {
  return role === "owner" || role === "admin";
}

/** 某角色能做的事（给面板用） */
export function capabilitiesOf(role) {
  const caps = ROLE_CAPABILITIES[String(role || "")];
  if (!caps) return [];
  if (caps.includes("*")) return Object.keys(CAPABILITIES);
  return caps.filter((k) => CAPABILITIES[k]);
}

/** 是否是合法的可分配角色 */
export function isAssignableRole(role) {
  return ASSIGNABLE_ROLES.includes(String(role || ""));
}

// ==========================================
// 查询与读写
// ==========================================

/**
 * 解析某个用户在当前部署里的角色。
 * @returns {Promise<"owner"|"admin"|"moderator"|null>}
 */
export async function getAdminRole(env, userId, { ownerId = null } = {}) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const owner = ownerId || env?.MY_TELEGRAM_ID;
  if (owner && id === String(owner).trim()) return "owner";
  if (!env?.DB) return null;

  const cached = ROLE_CACHE.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.role;

  try {
    const row = await env.DB.prepare(
      "SELECT role FROM bot_admins WHERE user_id = ?"
    ).bind(id).first();
    const role = String(row?.role || "");
    const resolved = isAssignableRole(role) ? role : null;
    // 缓存上限 500 条，满了直接清空（管理员很少，清了也不心疼）
    if (ROLE_CACHE.size > 500) ROLE_CACHE.clear();
    ROLE_CACHE.set(id, { role: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    return resolved;
  } catch (e) {
    logError("读取管理员角色失败：", e);
    return null;
  }
}

/**
 * 这个用户是不是「机器人管理员」（owner / admin / moderator）？
 *
 * **只用于「不可处置 / 不可封禁」这类硬性兜底**：封了自己人会让「谁能进后台」
 * 变得不可预期，而且被全局封禁的管理员连 `/unban` 都发不出去，只能由 owner 手动解。
 *
 * v3.7.0 修：这三处兜底原先**只认 owner**（`MY_TELEGRAM_ID`），于是任意用户
 * 自己建个群把机器人拉进去（他天然是本群管理员），就能用 `/ban <某 admin 的 id>`
 * 把除 owner 外的所有管理员全局锁死。
 *
 * @returns {Promise<boolean>}
 */
export async function isBotAdmin(env, userId) {
  const id = String(userId ?? "").trim();
  if (!id) return false;
  return (await getAdminRole(env, id)) !== null;
}

/** 列出所有额外授权的管理员（owner 由调用方单独展示） */
export async function listAdmins(env) {
  if (!env?.DB) return [];
  try {
    const { results } = await env.DB.prepare(`
      SELECT a.user_id, a.role, a.note, a.granted_by, a.created_at, a.updated_at,
             u.first_name, u.username
      FROM bot_admins a
      LEFT JOIN users u ON u.user_key = 'user:' || a.user_id
      ORDER BY CASE a.role WHEN 'admin' THEN 0 ELSE 1 END, a.user_id
    `).all();
    return results || [];
  } catch (e) {
    logError("读取管理员列表失败：", e);
    return [];
  }
}

/**
 * 添加 / 修改一个管理员。
 * @returns {Promise<{ok:boolean, error?:string, created?:boolean}>}
 */
export async function setAdmin(env, userId, role, { by = "", note = "" } = {}) {
  const id = String(userId || "").trim();
  if (!env?.DB) return { ok: false, error: "未绑定数据库" };
  if (!/^\d+$/.test(id)) return { ok: false, error: "用户 ID 必须是纯数字（Telegram 数字 ID）" };
  if (env.MY_TELEGRAM_ID && id === String(env.MY_TELEGRAM_ID).trim()) {
    return { ok: false, error: "拥有者由环境变量决定，不需要也不允许写进名单" };
  }
  if (!isAssignableRole(role)) return { ok: false, error: "角色只能是 admin 或 moderator" };

  const existed = Boolean(
    await env.DB.prepare("SELECT 1 AS ok FROM bot_admins WHERE user_id = ?").bind(id).first()
  );

  await env.DB.prepare(`
    INSERT INTO bot_admins (user_id, role, note, granted_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      role = EXCLUDED.role,
      note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE bot_admins.note END,
      granted_by = EXCLUDED.granted_by,
      updated_at = CURRENT_TIMESTAMP
  `).bind(id, String(role), String(note || "").slice(0, 60), String(by || "")).run();

  clearAdminCache();
  return { ok: true, created: !existed };
}

/** 移除一个管理员（owner 不在表里，天然移不掉） */
export async function removeAdmin(env, userId) {
  const id = String(userId || "").trim();
  if (!env?.DB) return { ok: false, error: "未绑定数据库" };
  if (env.MY_TELEGRAM_ID && id === String(env.MY_TELEGRAM_ID).trim()) {
    return { ok: false, error: "不能移除拥有者" };
  }
  const res = await env.DB.prepare("DELETE FROM bot_admins WHERE user_id = ?").bind(id).run();
  clearAdminCache();
  return res.meta.changes > 0
    ? { ok: true }
    : { ok: false, error: "该用户不在管理员名单里" };
}
