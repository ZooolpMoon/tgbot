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
// 三个作用域：
//   1. 默认（所有私聊）—— 普通用户命令
//   2. 所有群聊      —— 普通用户命令（去掉「仅私聊」的）
//   3. 管理员私聊    —— 全部命令（含管理命令），方便管理员点选
// ==========================================

import { setMyCommands } from "../telegram/api.js";
import { COMMANDS } from "../handlers/commands/registry.js";
import { getSetting, setSetting } from "./settings.js";
import { logWarn, logInfo } from "../core/logger.js";

const VERSION_KEY = "commands.version";

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
 * @param {{includeAdmin?:boolean, inGroup?:boolean}} opts
 */
export function buildCommandMenu({ includeAdmin = false, inGroup = false } = {}) {
  const list = [];
  for (const cmd of COMMANDS) {
    if (!includeAdmin && cmd.scope === "admin") continue;
    if (inGroup && cmd.privateOnly) continue;
    if (!inGroup && cmd.groupOnly) continue;
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
 * 同步命令菜单到 Telegram。
 * @param {object} env
 * @param {string} token
 * @param {{force?:boolean}} [opts] force = true 时忽略哈希直接同步
 * @returns {Promise<{synced:boolean, hash:string, count?:number, error?:string}>}
 */
export async function syncCommandMenu(env, token, { force = false } = {}) {
  if (!env?.DB || !token) return { synced: false, hash: "" };

  const publicMenu = buildCommandMenu({ includeAdmin: false, inGroup: false });
  const groupMenu = buildCommandMenu({ includeAdmin: false, inGroup: true });
  const adminMenu = buildCommandMenu({ includeAdmin: true, inGroup: false });
  const hash = menuHash([publicMenu, groupMenu, adminMenu]);

  const applied = await getSetting(env, VERSION_KEY, "");
  if (!force && applied === hash) return { synced: false, hash };

  try {
    const results = [];
    results.push(await setMyCommands(token, publicMenu));
    results.push(await setMyCommands(token, groupMenu, { type: "all_group_chats" }));

    // 管理员私聊：额外挂上管理命令，方便在输入框里点选
    const adminChatId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID).trim() : "";
    if (adminChatId) {
      results.push(await setMyCommands(token, adminMenu, { type: "chat", chat_id: adminChatId }));
    }

    const failed = results.find((r) => r && r.ok === false);
    if (failed) {
      logWarn("命令菜单同步失败：", failed.description || JSON.stringify(failed).slice(0, 120));
      return { synced: false, hash, error: failed.description || "同步失败" };
    }

    await setSetting(env, VERSION_KEY, hash);
    logInfo("命令菜单已同步：", JSON.stringify({
      public: publicMenu.length, group: groupMenu.length, admin: adminMenu.length
    }));
    return { synced: true, hash, count: adminMenu.length };
  } catch (e) {
    logWarn("命令菜单同步异常：", e?.message || e);
    return { synced: false, hash, error: String(e?.message || e) };
  }
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
