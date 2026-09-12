// ==========================================
// 👑 管理员与权限（管理端，v3.0.0）
//
// 入口：管理控制台 → 👑 管理员与权限（**只有拥有者能进**）
//   • 引导式添加管理员：输入用户 ID → 选角色 → 填备注
//   • 改名角色、移除（拥有者由环境变量决定，不在这张表里，动不了）
//   • 面板上直接列出每个角色能做什么，避免"给了权限却不知道给了什么"
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, clampPage, totalPagesOf, pageOffset, pagerRow, compactLabel, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { logAdminAction } from "../services/admin-log.js";
import { formatAppTime } from "../services/time.js";
import { logError } from "../core/logger.js";
import {
  ASSIGNABLE_ROLES, CAPABILITIES, ROLES, capabilitiesOf, isAssignableRole,
  listAdmins, removeAdmin, roleLabel, setAdmin
} from "../services/admins.js";

const PER_PAGE = 6;
/** 引导会话 30 分钟有效，和其它引导流程一致 */
const SESSION_TTL_MINUTES = 30;

/**
 * 授权 / 改角色 / 移除之后，让输入框命令菜单立刻跟上。
 * 菜单哈希里带了「挂给谁」，所以下一次 isolate 自检本来也会同步（或让管理员发 /syncmenu）；
 * 这里只是不等那一刻 —— 新增的管理员一进去就能在输入框里看到自己那份。
 */
async function refreshCommandMenu(env, token) {
  try {
    const { syncCommandMenu } = await import("../services/command-menu.js");
    await syncCommandMenu(env, token, { force: true });
  } catch (e) {
    logError("刷新命令菜单失败：", e);
  }
}

// ---------- 引导会话 ----------
async function setSession(env, chatId, step, draft = null) {
  await env.DB.prepare(`
    INSERT INTO admin_manage_sessions (chat_id, step, draft, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      step = EXCLUDED.step, draft = EXCLUDED.draft, updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, step, draft ? JSON.stringify(draft) : "").run();
}

async function getSession(env, chatId) {
  if (!env?.DB || !chatId) return null;
  return env.DB.prepare(
    `SELECT * FROM admin_manage_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
}

async function clearSession(env, chatId) {
  if (!env?.DB) return;
  await env.DB.prepare("DELETE FROM admin_manage_sessions WHERE chat_id = ?").bind(chatId).run();
}

function parseDraft(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 管理员是否正在走「添加管理员」引导（用于放行群里的文本输入） */
export async function isAdminGuideActive(env, chatId) {
  if (!env?.DB) return false;
  return Boolean(await getSession(env, chatId));
}

/** 取消引导 */
export async function cancelAdminGuide({ env, token, chatId }) {
  await clearSession(env, chatId);
  return sendMessage(token, chatId, "🚫 已取消添加管理员。");
}

// ==========================================
// 面板渲染
// ==========================================

/** 角色说明文案（面板与引导都用它） */
export function buildRoleHelpText() {
  const lines = [ROLES.owner, ROLES.admin, ROLES.moderator].map((r) =>
    `${r.label} —— ${r.desc}`
  );
  return lines.join("\n");
}

/** 管理员列表键盘（纯函数，便于排版测试） */
export function getAdminsKeyboard(rows, safePage, totalPages) {
  const buttons = rows.map((row) => {
    const name = row.first_name || row.username || row.user_id;
    const icon = row.role === "admin" ? "🛡️" : "⚔️";
    return {
      text: compactLabel(`${icon} ${name}`, 28),
      callback_data: `${ADMIN_CALLBACK.ADMINS_USER_PREFIX}${row.user_id}`
    };
  });

  const inline_keyboard = grid(buttons);
  inline_keyboard.push([
    { text: "➕ 添加管理员", callback_data: ADMIN_CALLBACK.ADMINS_ADD },
    { text: "📖 角色说明", callback_data: ADMIN_CALLBACK.ADMINS_HELP }
  ]);

  const navRow = pagerRow({ page: safePage, totalPages, prefix: ADMIN_CALLBACK.ADMINS_PAGE_PREFIX });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]);
  return { inline_keyboard };
}

/** 管理员列表 */
export async function renderAdminsPanel(token, env, chatId, messageId = null, page = 1) {
  if (!env.DB) {
    const t = "❌ 未绑定数据库。";
    return messageId ? editMessageText(token, chatId, messageId, t) : sendMessage(token, chatId, t);
  }

  const rows = await listAdmins(env);
  const totalPages = totalPagesOf(rows.length, PER_PAGE);
  const safePage = clampPage(page, totalPages);
  const start = pageOffset(safePage, PER_PAGE);
  const pageRows = rows.slice(start, start + PER_PAGE);
  const ownerId = env.MY_TELEGRAM_ID ? String(env.MY_TELEGRAM_ID) : "（未配置 MY_TELEGRAM_ID）";

  let text = `👑 <b>管理员与权限</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `🌍 <b>拥有者：</b> <code>${escapeHtml(ownerId)}</code>（环境变量决定，不能在此修改）\n`;
  text += `👥 <b>额外授权：</b> ${rows.length} 人${rows.length > 0 ? `（第 ${safePage} / ${totalPages} 页）` : ""}\n\n`;
  text += `<b>角色能力：</b>\n${buildRoleHelpText()}\n\n`;

  if (pageRows.length === 0) {
    text += `<i>还没有额外授权的管理员，点「➕ 添加管理员」加一个。</i>`;
  } else {
    text += `<b>点一个人可以改角色或移除：</b>\n`;
    for (const row of pageRows) {
      const name = escapeHtml(row.first_name || row.username || "未命名");
      text += `${row.role === "admin" ? "🛡️" : "⚔️"} <b>${name}</b> · ${roleLabel(row.role)} · <code>${escapeHtml(row.user_id)}</code>\n`;
      if (row.note) text += `    └ ${escapeHtml(row.note)}\n`;
    }
  }

  const keyboard = getAdminsKeyboard(pageRows, safePage, totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 单个管理员的详情 / 操作面板 */
export async function renderAdminDetail(token, env, chatId, messageId, userId) {
  const rows = await listAdmins(env);
  const row = rows.find((r) => String(r.user_id) === String(userId));
  if (!row) {
    return editMessageText(token, chatId, messageId, "❌ 该管理员已被移除。",
      { inline_keyboard: [[{ text: "🔙 返回列表", callback_data: ADMIN_CALLBACK.ADMINS_HOME }]] });
  }

  const caps = capabilitiesOf(row.role).map((k) => `• ${CAPABILITIES[k]}`).join("\n");
  const nextRole = row.role === "admin" ? "moderator" : "admin";
  const text =
    `👑 <b>管理员详情</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `👤 <b>名字：</b> ${escapeHtml(row.first_name || row.username || "未命名")}\n` +
    `🆔 <b>用户 ID：</b> <code>${escapeHtml(row.user_id)}</code>\n` +
    `🎖️ <b>角色：</b> ${roleLabel(row.role)}\n` +
    (row.note ? `📝 <b>备注：</b> ${escapeHtml(row.note)}\n` : ``) +
    `👑 <b>授权人：</b> <code>${escapeHtml(row.granted_by || "—")}</code>\n` +
    `🕒 <b>授权时间：</b> ${escapeHtml(formatAppTime(env, row.created_at))}\n\n` +
    `<b>该角色可以做：</b>\n${caps}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `🔁 改为${ROLES[nextRole].label}`, callback_data: `${ADMIN_CALLBACK.ADMINS_SET_PREFIX}${nextRole}_${row.user_id}` }],
      [{ text: "🗑️ 移除管理员", callback_data: `${ADMIN_CALLBACK.ADMINS_DEL_PREFIX}${row.user_id}` }],
      [{ text: "🔙 返回列表", callback_data: ADMIN_CALLBACK.ADMINS_HOME }]
    ]
  };
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ==========================================
// 引导式添加
// ==========================================

/** 开始添加管理员：第 1 步要用户 ID */
export async function startAddAdmin({ env, token, chatId }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const { clearGuideSessions } = await import("../services/sessions.js");
  await clearGuideSessions(env, chatId);
  await setSession(env, chatId, "add:user", {});

  return sendMessage(
    token, chatId,
    `➕ <b>添加管理员 · 第 1 步</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `请发送对方的 <b>Telegram 数字 ID</b>（不是 @用户名）。\n` +
    `查 ID 的办法：让对方发一条消息，然后在 <b>用户管理 → 用户详情</b> 里看「用户 ID」，或让对方找 @userinfobot 查。\n\n` +
    `（回复 <code>/cancel</code> 放弃）`,
    "HTML"
  );
}

/** 第 2 步：选角色（按钮） */
async function promptRole({ env, token, chatId, userId }) {
  const keyboard = {
    inline_keyboard: [
      ...ASSIGNABLE_ROLES.map((role) => ([{
        text: `${ROLES[role].label} —— ${role === "admin" ? "后台全部（除权限管理）" : "只能执法"}`,
        callback_data: `${ADMIN_CALLBACK.ADMINS_GUIDE_ROLE_PREFIX}${role}`
      }]))
    ]
  };
  return sendMessageWithKeyboard(
    token, chatId,
    `➕ <b>添加管理员 · 第 2 步</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `用户 ID：<code>${escapeHtml(userId)}</code>\n\n请选择角色：\n${buildRoleHelpText()}`,
    keyboard, "HTML"
  );
}

/** 第 3 步：备注 */
async function promptNote({ env, token, chatId, userId, role }) {
  return sendMessage(
    token, chatId,
    `➕ <b>添加管理员 · 第 3 步</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `用户 ID：<code>${escapeHtml(userId)}</code>\n` +
    `角色：${roleLabel(role)}\n\n` +
    `请输入<b>备注</b>（例如「副管理员小王」，方便日后辨认；回复 <code>-</code> 表示不填）：`,
    "HTML"
  );
}

/** 引导里的角色选择按钮 */
export async function handleAdminGuideRolePick({ env, token, callback, chatId, data }) {
  const role = String(data).replace(ADMIN_CALLBACK.ADMINS_GUIDE_ROLE_PREFIX, "");
  if (!isAssignableRole(role)) {
    await answerCallback(token, callback.id, "⚠️ 未知角色", true);
    return;
  }

  const session = await getSession(env, chatId);
  const draft = parseDraft(session?.draft);
  if (!session || !String(session.step).startsWith("add:") || !draft.userId) {
    await answerCallback(token, callback.id, "⚠️ 流程已过期，请重新点「➕ 添加管理员」", true);
    return;
  }

  draft.role = role;
  await setSession(env, chatId, "add:note", draft);
  await answerCallback(token, callback.id, `已选择：${roleLabel(role)}`);
  await promptNote({ env, token, chatId, userId: draft.userId, role });
}

/**
 * 引导流程里的文本输入。
 * @returns {Promise<boolean>} 是否已消费这条消息
 */
export async function handleAdminGuideInput({ env, token, chatId, userText, adminId = null }) {
  if (!env.DB) return false;

  const session = await getSession(env, chatId);
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  const step = String(session.step || "");
  const draft = parseDraft(session.draft);

  // ---- 第 1 步：用户 ID ----
  if (step === "add:user") {
    if (!/^\d+$/.test(text)) {
      await sendMessage(token, chatId, "⚠️ 用户 ID 必须是<b>纯数字</b>（例如 <code>123456789</code>），请重新发送：", "HTML");
      return true;
    }
    if (env.MY_TELEGRAM_ID && text === String(env.MY_TELEGRAM_ID)) {
      await sendMessage(token, chatId, "ℹ️ 这是<b>拥有者</b>自己的 ID，不需要添加（拥有者永远有全部权限）。\n请发送别人的 ID：", "HTML");
      return true;
    }

    const existed = (await listAdmins(env)).some((r) => String(r.user_id) === text);
    draft.userId = text;
    await setSession(env, chatId, "add:role", draft);
    if (existed) {
      await sendMessage(token, chatId, `ℹ️ 该用户已经是管理员，继续操作会<b>覆盖</b>他的角色。`, "HTML");
    }
    await promptRole({ env, token, chatId, userId: text });
    return true;
  }

  // ---- 第 3 步：备注 ----
  if (step === "add:note") {
    const note = text === "-" ? "" : text.slice(0, 60);
    const res = await setAdmin(env, draft.userId, draft.role, { by: adminId, note });
    await clearSession(env, chatId);

    if (!res.ok) {
      await sendMessage(token, chatId, `❌ 添加失败：${res.error}`);
      return true;
    }

    await logAdminAction(env, {
      adminId, chatId,
      action: res.created ? "admin_add" : "admin_update",
      detail: `${draft.userId} → ${draft.role}${note ? `（${note}）` : ""}`
    });
    // 菜单里带上「挂给谁」，改了名单就让输入框菜单跟着变
    await refreshCommandMenu(env, token);
    await sendMessage(
      token, chatId,
      `✅ <b>已${res.created ? "添加" : "更新"}管理员</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🆔 <code>${escapeHtml(draft.userId)}</code>\n` +
      `🎖️ 角色：${roleLabel(draft.role)}\n` +
      `💡 记得私聊他一句：先发 <code>/admin</code> 解锁就能用后台了。`,
      "HTML"
    );
    await renderAdminsPanel(token, env, chatId, null);
    return true;
  }

  // 未知步骤：清掉，交回正常流程
  await clearSession(env, chatId);
  return false;
}

// ==========================================
// 回调分发（admin_admins*）
// ==========================================

export async function handleAdminsCallback({ env, token, callback, chatId, msgId, data, adminId = null, uctx = null }) {
  if (!env.DB) {
    await answerCallback(token, callback.id, "❌ 未绑定数据库", true);
    return;
  }
  const raw = String(data || "");

  if (raw === ADMIN_CALLBACK.ADMINS_HOME) {
    await answerCallback(token, callback.id, "管理员与权限");
    await renderAdminsPanel(token, env, chatId, msgId);
    return;
  }

  if (raw === ADMIN_CALLBACK.ADMINS_HELP) {
    await answerCallback(token, callback.id, "角色说明", true);
    await editMessageText(
      token, chatId, msgId,
      `👑 <b>角色说明</b>\n${LAYOUT.DIVIDER}\n${buildRoleHelpText()}\n\n` +
      `🛡️ <b>管理员</b>能进后台、管理用户 / 商城 / 知识库 / 功能开关，但<b>不能</b>增减管理员。\n` +
      `⚔️ <b>执法员</b>只能：封禁 / 踢出 / 禁言 / 查看群规 / 处理成员举报与申诉，不能进后台。`,
      { inline_keyboard: [[{ text: "🔙 返回列表", callback_data: ADMIN_CALLBACK.ADMINS_HOME }]] },
      "HTML"
    );
    return;
  }

  if (raw === ADMIN_CALLBACK.ADMINS_ADD) {
    await answerCallback(token, callback.id, "开始添加管理员");
    await startAddAdmin({ env, token, chatId });
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_GUIDE_ROLE_PREFIX)) {
    await handleAdminGuideRolePick({ env, token, callback, chatId, data });
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_PAGE_PREFIX)) {
    const page = Number.parseInt(raw.replace(ADMIN_CALLBACK.ADMINS_PAGE_PREFIX, ""), 10) || 1;
    await answerCallback(token, callback.id, `第 ${page} 页`);
    await renderAdminsPanel(token, env, chatId, msgId, page);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_SET_PREFIX)) {
    // admin_admins_set_<role>_<userId>
    const rest = raw.slice(ADMIN_CALLBACK.ADMINS_SET_PREFIX.length);
    const sep = rest.indexOf("_");
    const role = sep === -1 ? "" : rest.slice(0, sep);
    const userId = sep === -1 ? rest : rest.slice(sep + 1);
    if (!isAssignableRole(role) || !userId) {
      await answerCallback(token, callback.id, "⚠️ 参数无效", true);
      return;
    }
    const res = await setAdmin(env, userId, role, { by: adminId });
    await logAdminAction(env, {
      adminId, chatId, action: "admin_update", detail: `${userId} → ${role}（改角色）`
    });
    if (res.ok) await refreshCommandMenu(env, token);
    await answerCallback(token, callback.id, res.ok ? `✅ 已改为${roleLabel(role)}` : `⚠️ ${res.error}`, !res.ok);
    await renderAdminDetail(token, env, chatId, msgId, userId);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_DELOK_PREFIX)) {
    const userId = raw.slice(ADMIN_CALLBACK.ADMINS_DELOK_PREFIX.length);
    const res = await removeAdmin(env, userId);
    await logAdminAction(env, {
      adminId, chatId, action: "admin_remove", detail: `${userId}（${res.ok ? "成功" : res.error}）`
    });
    // 移除后要把他那份管理菜单清掉，否则输入框里还留着点不动的命令
    if (res.ok) await refreshCommandMenu(env, token);
    await answerCallback(token, callback.id, res.ok ? "🗑️ 已移除" : `⚠️ ${res.error}`, !res.ok);
    await renderAdminsPanel(token, env, chatId, msgId);
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_DEL_PREFIX)) {
    const userId = raw.slice(ADMIN_CALLBACK.ADMINS_DEL_PREFIX.length);
    const row = (await listAdmins(env)).find((r) => String(r.user_id) === userId);
    if (!row) {
      await answerCallback(token, callback.id, "❌ 该管理员不存在", true);
      return;
    }
    await answerCallback(token, callback.id, "请确认移除");
    await editMessageText(
      token, chatId, msgId,
      `🗑️ <b>确认移除管理员？</b>\n${LAYOUT.DIVIDER}\n` +
      `👤 ${escapeHtml(row.first_name || row.username || "未命名")}（<code>${escapeHtml(userId)}</code>）\n` +
      `🎖️ ${roleLabel(row.role)}\n\n移除后他就用不了后台了（群里作为本群管理员的执法能力不受影响）。`,
      {
        inline_keyboard: [
          [{ text: "🗑️ 确认移除", callback_data: `${ADMIN_CALLBACK.ADMINS_DELOK_PREFIX}${userId}` }],
          [{ text: "🔙 再想想", callback_data: `${ADMIN_CALLBACK.ADMINS_USER_PREFIX}${userId}` }]
        ]
      },
      "HTML"
    );
    return;
  }

  if (raw.startsWith(ADMIN_CALLBACK.ADMINS_USER_PREFIX)) {
    const userId = raw.slice(ADMIN_CALLBACK.ADMINS_USER_PREFIX.length);
    await answerCallback(token, callback.id, "管理员详情");
    await renderAdminDetail(token, env, chatId, msgId, userId);
    return;
  }

  await answerCallback(token, callback.id, "⚠️ 未知操作", true);
}
