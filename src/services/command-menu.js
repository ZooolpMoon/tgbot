// ==========================================
// ⌨️ 输入框命令菜单
//
// 作用：用户在聊天框输入「/」时，Telegram 会弹出指令列表（不用记命令名）。
// 菜单内容直接由命令注册表生成，**加新命令不用改这里**。
//
// 同步策略：
//   • 用内容哈希做版本标记，存进全局设置 commands.version；
//   • 每次请求（放在 waitUntil 里）比对哈希，变了才调用 Telegram，避免刷接口；
//   • 管理员可用 /syncmenu 强制同步。
//
// 作用域按「多管理员模型」生成（v3.1.3 起）：
//   1. 默认（所有私聊）    —— 普通用户命令
//   2. 所有群聊            —— 普通用户命令（去掉「仅私聊」的）
//   3. owner 私聊          —— 全部管理指令
//   4. 每个 bot_admin 私聊 —— 只挂他有能力用的（执法员看不到兑换码 / 群发）
//   5. 每个已知群的管理员  —— chat_administrators，本群管理员也能看到执法指令
// 上一次挂过、这次不再需要的作用域会被**清空**：否则被移除的管理员，
// 输入框里还留着一串他其实点不动的管理命令。
// ==========================================

import { setMyCommands } from "../telegram/api.js";
import { COMMANDS } from "../handlers/commands/registry.js";
import { getSetting, setSetting } from "./settings.js";
import { can } from "./admins.js";
import { logWarn, logInfo } from "../core/logger.js";

const VERSION_KEY = "commands.version";
/** 记录「上一次挂过哪些作用域」，用来清理已经失效的那些 */
const SCOPES_KEY = "commands.scopes";

/** 单个作用域一次 setMyCommands；这两个上限是为了别把接口调爆（超出的会在日志里提示） */
const MAX_ADMIN_SCOPES = 20;
const MAX_GROUP_SCOPES = 20;

/** 同一个 Worker isolate 内只做一次「版本比对」，避免每次更新都读一次设置 */
let checkedInThisIsolate = false;

/** Telegram 对命令名与描述的限制：名称不带斜杠、小写字母数字下划线，描述 3~256 字 */
function normalizeCommand(cmd) {
  const command = String(cmd.name || "").replace(/^\//, "").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(command)) return null;

  let description = String(cmd.desc || "").replace(/\s+/g, " ").trim();
  if (description.length > 60) description = description.slice(0, 59) + "…";
  if (description.length < 3) return null;

  return { command, description };
}

/**
 * 由注册表生成命令菜单。
 *
 * 管理指令按身份裁：
 *   • role 给了（owner / admin / moderator）→ 按 capability 裁，moderator 只拿到执法指令
 *   • role 没给但 groupAdmin = true → 只给带 groupAdmin 标记的执法指令（本群管理员）
 *   • 两个都没给但 includeAdmin = true → 全部管理指令（owner 的菜单，也是历史默认行为）
 *
 * @param {{includeAdmin?:boolean, inGroup?:boolean, role?:string|null, groupAdmin?:boolean}} opts
 */
export function buildCommandMenu({
  includeAdmin = false, inGroup = false, role = null, groupAdmin = false
} = {}) {
  const list = [];
  for (const cmd of COMMANDS) {
    if (inGroup && cmd.privateOnly) continue;
    if (!inGroup && cmd.groupOnly) continue;
    if (cmd.scope === "admin") {
      if (!includeAdmin) continue;
      const allowed = role
        ? (cmd.capability ? can(role, cmd.capability) : true)
        : groupAdmin ? cmd.groupAdmin === true : true;
      if (!allowed) continue;
    }
    const item = normalizeCommand(cmd);
    if (item) list.push(item);
  }
  // Telegram 上限 100 条
  return list.slice(0, 100);
}

/** 内容哈希：菜单变了才重新同步（djb2，够用且同步计算） */
export function menuHash(menus) {
  const text = JSON.stringify(menus);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `v${(hash >>> 0).toString(36)}`;
}

/**
 * 计算「要把哪份菜单挂到哪个作用域」。
 *
 * 顺序即调用顺序，也参与哈希：列表变了（新增管理员 / 群里第一次见到消息）就重新同步。
 * @returns {Promise<Array<{key:string, label:string, scope:object|null, commands:Array}>>}
 */
async function buildMenuTargets(env) {
  const ownerId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID).trim() : "";
  const targets = [
    {
      key: "scope:default", label: "所有私聊", scope: null,
      commands: buildCommandMenu({})
    },
    {
      key: "scope:all_group_chats", label: "所有群聊", scope: { type: "all_group_chats" },
      commands: buildCommandMenu({ inGroup: true })
    }
  ];

  if (ownerId) {
    targets.push({
      key: `scope:chat:${ownerId}`, label: `拥有者私聊 ${ownerId}`,
      scope: { type: "chat", chat_id: ownerId },
      commands: buildCommandMenu({ includeAdmin: true, role: "owner" })
    });
  }

  if (env?.DB) {
    // 被授权的管理员：各自那份菜单（按角色裁）
    try {
      const { results } = await env.DB.prepare(
        "SELECT user_id, role FROM bot_admins ORDER BY user_id LIMIT ?"
      ).bind(MAX_ADMIN_SCOPES).all();
      for (const row of results || []) {
        const id = String(row.user_id || "").trim();
        const role = String(row.role || "").trim();
        if (!id || id === ownerId) continue;
        targets.push({
          key: `scope:chat:${id}`, label: `${role || "管理员"}私聊 ${id}`,
          scope: { type: "chat", chat_id: id },
          commands: buildCommandMenu({ includeAdmin: true, role })
        });
      }
    } catch (e) {
      logWarn("读取管理员名单失败（跳过管理员菜单）：", e?.message || e);
    }

    // 机器人待过的群：给「本群管理员」挂一份执法菜单
    try {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT chat_id FROM user_scenes
          WHERE chat_type IN ('group', 'supergroup') AND chat_id IS NOT NULL AND chat_id <> ''
          ORDER BY chat_id LIMIT ?`
      ).bind(MAX_GROUP_SCOPES).all();
      const guardMenu = buildCommandMenu({ includeAdmin: true, inGroup: true, groupAdmin: true });
      for (const row of results || []) {
        const chatId = String(row.chat_id || "").trim();
        if (!chatId) continue;
        targets.push({
          key: `scope:chat_administrators:${chatId}`, label: `群管理员 ${chatId}`,
          scope: { type: "chat_administrators", chat_id: chatId },
          commands: guardMenu
        });
      }
    } catch (e) {
      logWarn("读取群列表失败（跳过群管理员菜单）：", e?.message || e);
    }
  }

  return targets;
}

/** 解析上一次记录的作用域列表（脏数据就当空） */
function parseMountedScopes(raw) {
  try {
    const list = JSON.parse(String(raw || "[]"));
    return Array.isArray(list) ? list.filter((s) => s && s.key && (s.scope === null || typeof s.scope === "object")) : [];
  } catch {
    return [];
  }
}

/**
 * 同步命令菜单到 Telegram。
 * @param {object} env
 * @param {string} token
 * @param {{force?:boolean}} [opts] force = true 时忽略哈希直接同步
 * @returns {Promise<{synced:boolean, hash:string, count?:number, cleared?:number, error?:string}>}
 */
export async function syncCommandMenu(env, token, { force = false } = {}) {
  if (!env?.DB || !token) return { synced: false, hash: "" };

  const targets = await buildMenuTargets(env);
  const hash = menuHash(targets.map((t) => ({ key: t.key, commands: t.commands })));

  const mounted = parseMountedScopes(await getSetting(env, SCOPES_KEY, ""));
  const stale = mounted.filter((s) => !targets.some((t) => t.key === s.key));

  const applied = await getSetting(env, VERSION_KEY, "");
  if (!force && applied === hash && stale.length === 0) return { synced: false, hash };

  const failures = [];
  try {
    // 串行调用：作用域数量不多，串行能少踩 Telegram 的限流
    for (const target of targets) {
      const res = await setMyCommands(token, target.commands, target.scope);
      if (res && res.ok === false) {
        failures.push(`${target.label}：${res.description || "同步失败"}`);
      }
    }

    // 已经不适用的作用域要清空，否则被移除的管理员输入框里还会留着管理指令
    for (const gone of stale) {
      const res = await setMyCommands(token, [], gone.scope);
      if (res && res.ok === false) {
        failures.push(`${gone.label}（清理）：${res.description || "同步失败"}`);
      }
    }
  } catch (e) {
    logWarn("命令菜单同步异常：", e?.message || e);
    return { synced: false, hash, error: String(e?.message || e) };
  }

  // 个别作用域失败（例如机器人已被移出那个群）不阻塞版本标记，
  // 否则每次冷启动都会重试整套同步、把接口刷爆。
  if (failures.length > 0) {
    logWarn("命令菜单部分作用域同步失败：", failures.join("；").slice(0, 200));
    if (failures.length >= targets.length + stale.length) {
      return { synced: false, hash, error: failures[0] };
    }
  }

  await setSetting(env, VERSION_KEY, hash);
  await setSetting(env, SCOPES_KEY, JSON.stringify(
    targets.map((t) => ({ key: t.key, label: t.label, scope: t.scope }))
  ));
  logInfo("命令菜单已同步：", JSON.stringify({
    scopes: targets.length, cleared: stale.length, failed: failures.length
  }));
  return { synced: true, hash, count: targets.length, cleared: stale.length };
}

/**
 * 每个 isolate 只检查一次（内容没变时零 Telegram 调用）。
 * 强制同步请直接调用 syncCommandMenu(..., { force: true })。
 */
export async function syncCommandMenuOnce(env, token) {
  if (checkedInThisIsolate) return { synced: false, hash: "" };
  checkedInThisIsolate = true;
  return syncCommandMenu(env, token);
}

/** 测试用：重置 isolate 标记 */
export function resetCommandMenuCache() {
  checkedInThisIsolate = false;
}
