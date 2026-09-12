// ==========================================
// ✅ 每日任务管理（引导式增删改）
//
// 任务定义存在 daily_task_defs：
//   触发条件（代码定义）+ 任务名称 + 完成提示 + 奖励积分 + 启用状态
// 引导状态存在 task_edit_sessions（step: add:label / edit:points / bonus ...）
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, totalPagesOf, pagerRow, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import { TASK_TRIGGERS, triggerLabel } from "../config/tasks.js";
import {
  listTaskDefs, getTaskDef, createTaskDef, updateTaskDef, deleteTaskDef,
  getTaskBonus, setTaskBonus
} from "../services/tasks.js";
import { logAdminAction } from "../services/admin-log.js";

const MAX_POINTS = 1000;

/** 任务列表每页显示多少个（2 列 × 3 行，给翻页和按钮留出空间） */
const TASKS_PER_PAGE = 6;

// ---------- 引导会话 ----------
// 会话超过 30 分钟自动失效：否则管理员点开「添加任务」后走开，
// 之后所有私聊文本都会被当成任务输入吞掉（真实踩过的坑）。
const SESSION_TTL_MINUTES = 30;

/** 写入 / 刷新引导会话（每次输入都会刷新 updated_at，等于续期） */
async function setSession(env, chatId, step, taskId = null, draft = null) {
  await env.DB.prepare(`
    INSERT INTO task_edit_sessions (chat_id, task_id, step, draft, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      task_id = EXCLUDED.task_id, step = EXCLUDED.step, draft = EXCLUDED.draft, updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, taskId, step, draft ? JSON.stringify(draft) : "").run();
}

/** 读取未过期的引导会话；过期的行由定时任务统一清理 */
async function getSession(env, chatId) {
  if (!env.DB || !chatId) return null;
  return env.DB.prepare(
    `SELECT * FROM task_edit_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
}

/** 删除引导会话（流程结束或取消时调用） */
async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM task_edit_sessions WHERE chat_id = ?").bind(chatId).run();
}

/** 安全解析会话里的草稿 JSON（脏数据不应该让整条链路抛异常） */
function parseDraft(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 任务列表正文（只渲染当前页的任务） */
async function taskListText(env) {
  const defs = await listTaskDefs(env);
  const bonus = await getTaskBonus(env);
  return { defs, bonus };
}

/** 某个任务在第几页（找不到时回到第 1 页） */
export function pageOfTask(defs, taskId) {
  const index = (defs || []).findIndex((d) => Number(d.id) === Number(taskId));
  if (index < 0) return 1;
  return Math.floor(index / TASKS_PER_PAGE) + 1;
}

/**
 * 任务列表键盘（纯函数，便于排版测试）。
 * 每页最多 6 个任务 = 3 行，加「添加/全勤奖」1 行、翻页 1 行、返回 1 行，共 6 行。
 */
export function getTaskListKeyboard(pageDefs, safePage, totalPages) {
  const inline_keyboard = grid(
    pageDefs.map((d) => ({
      // 任务名最长 40 字，按钮文案必须压缩，否则会超出 Telegram 的显示宽度
      text: compactLabel(`${Number(d.enabled) === 1 ? "✅" : "🚫"} ${d.label} +${d.points}`, 30),
      callback_data: `${ADMIN_CALLBACK.TASK_DETAIL_PREFIX}${d.id}`
    })),
    2
  );
  inline_keyboard.push([
    { text: "➕ 添加任务", callback_data: ADMIN_CALLBACK.TASK_ADD },
    { text: "🏆 修改全勤奖", callback_data: ADMIN_CALLBACK.TASK_BONUS }
  ]);

  const navRow = pagerRow({ page: safePage, totalPages, prefix: `${ADMIN_CALLBACK.TASKS_PREFIX}_p` });
  if (navRow) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]);
  return { inline_keyboard };
}

/**
 * 每日任务管理面板。
 * 任务数量由管理员自由增删，所以列表必须分页，否则按钮行数会无限增长。
 */
export async function renderTaskAdmin(token, env, chatId, messageId = null, page = 1) {
  if (!env.DB) {
    const t = "❌ 未绑定数据库。";
    return messageId ? editMessageText(token, chatId, messageId, t) : sendMessage(token, chatId, t);
  }

  const { defs, bonus } = await taskListText(env);
  const totalPages = totalPagesOf(defs.length, TASKS_PER_PAGE);
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * TASKS_PER_PAGE;
  const pageDefs = defs.slice(start, start + TASKS_PER_PAGE);

  let text = `✅ <b>每日任务管理</b>\n`;
  text += `共 <b>${defs.length}</b> 个任务（启用 <b>${defs.filter((d) => Number(d.enabled) === 1).length}</b> 个）\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>\n`;
  text += `🏆 全勤奖：<b>${bonus}</b> 积分\n`;
  text += `${LAYOUT.DIVIDER}\n`;

  if (pageDefs.length === 0) {
    text += `<i>还没有任务，点「➕ 添加任务」创建一个。</i>\n`;
  } else {
    for (const d of pageDefs) {
      text += `${Number(d.enabled) === 1 ? "✅" : "🚫"} <b>${escapeHtml(d.label)}</b> · +${d.points}\n`;
      text += `    └ 触发：${escapeHtml(triggerLabel(d.trigger))}${d.hint ? ` · 提示：${escapeHtml(d.hint)}` : ""}\n`;
    }
  }

  const keyboard = getTaskListKeyboard(pageDefs, safePage, totalPages);
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/**
 * 任务详情面板。
 * 返回按钮会回到该任务所在的页码（任务多时不会把管理员丢回第一页）。
 */
export async function renderTaskDetail(token, env, chatId, messageId, taskId) {
  if (!env.DB) return;

  const def = await getTaskDef(env, taskId);
  if (!def) {
    return editMessageText(token, chatId, messageId, "❌ 任务不存在（可能已被删除）。",
      { inline_keyboard: [[{ text: "🔙 返回任务列表", callback_data: ADMIN_CALLBACK.TASKS_PREFIX }]] });
  }

  const allDefs = await listTaskDefs(env);
  const backPage = pageOfTask(allDefs, taskId);
  const listCallback = backPage > 1 ? `${ADMIN_CALLBACK.TASKS_PREFIX}_p${backPage}` : ADMIN_CALLBACK.TASKS_PREFIX;

  const text =
    `✅ <b>任务 #${def.id}</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `📛 <b>名称：</b> ${escapeHtml(def.label)}\n` +
    `⚡ <b>触发条件：</b> ${escapeHtml(triggerLabel(def.trigger))}\n` +
    `💬 <b>完成提示：</b> ${escapeHtml(def.hint) || "（无）"}\n` +
    `🎁 <b>奖励：</b> +${def.points} 积分\n` +
    `🔘 <b>状态：</b> ${Number(def.enabled) === 1 ? "✅ 启用中" : "🚫 已停用"}\n\n` +
    `触发条件由代码定义（机器人只能观测到有限的行为），名称、提示与奖励可以随意改。`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📛 改名称", callback_data: `${ADMIN_CALLBACK.TASK_FIELD_PREFIX}${def.id}_label` },
        { text: "🎁 改奖励", callback_data: `${ADMIN_CALLBACK.TASK_FIELD_PREFIX}${def.id}_points` }
      ],
      [
        { text: "💬 改提示", callback_data: `${ADMIN_CALLBACK.TASK_FIELD_PREFIX}${def.id}_hint` },
        {
          text: Number(def.enabled) === 1 ? "🚫 停用" : "✅ 启用",
          callback_data: `${ADMIN_CALLBACK.TASK_TOGGLE_PREFIX}${def.id}`
        }
      ],
      [{ text: "🗑️ 删除任务", callback_data: `${ADMIN_CALLBACK.TASK_DEL_PREFIX}${def.id}` }],
      [{ text: "🔙 返回任务列表", callback_data: listCallback }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ---------- 引导式：添加任务 ----------
/** 第 1 步：让管理员从代码定义好的触发条件里挑一个 */
export async function startTaskAdd({ env, token, chatId }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  // 商城添加/编辑是另外两套引导流程，开始任务引导前先清掉，避免互相抢消息
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shop_add_sessions WHERE chat_id = ?").bind(chatId),
    env.DB.prepare("DELETE FROM shop_edit_sessions WHERE chat_id = ?").bind(chatId)
  ]);
  await setSession(env, chatId, "add:trigger", null, {});

  const text =
    `➕ <b>添加每日任务 · 第 1 步</b>\n` +
    `-------------------------\n` +
    `先选一个<b>触发条件</b>——也就是「机器人能观测到什么行为」：\n\n` +
    TASK_TRIGGERS.map((t) => `• <b>${t.label}</b> —— ${t.hint}`).join("\n") +
    `\n\n（随时回复 <code>/cancel</code> 放弃）`;

  const inline_keyboard = TASK_TRIGGERS.map((t) => [
    { text: t.label, callback_data: `${ADMIN_CALLBACK.TASK_PICK_PREFIX}${t.key}` }
  ]);
  inline_keyboard.push([{ text: "❌ 取消", callback_data: ADMIN_CALLBACK.TASKS_PREFIX }]);

  return sendMessageWithKeyboard(token, chatId, text, { inline_keyboard }, "HTML");
}

/** 处理「选择触发条件」，通过后进入第 2 步（输入任务名称） */
export async function handleTaskTriggerPick({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const trigger = String(data).replace(ADMIN_CALLBACK.TASK_PICK_PREFIX, "");
  const session = await getSession(env, chatId);
  if (!session || !String(session.step).startsWith("add:")) {
    await answerCallback(token, callback.id, "⚠️ 引导流程已过期，请重新点击「➕ 添加任务」", true);
    return;
  }
  if (!TASK_TRIGGERS.some((t) => t.key === trigger)) {
    await answerCallback(token, callback.id, "⚠️ 未知的触发条件", true);
    return;
  }

  await setSession(env, chatId, "add:label", null, { trigger });
  await answerCallback(token, callback.id, `已选择：${triggerLabel(trigger)}`);
  await sendMessage(
    token, chatId,
    `➕ <b>添加每日任务 · 第 2 步</b>\n-------------------------\n` +
    `触发条件：<b>${escapeHtml(triggerLabel(trigger))}</b>\n\n` +
    `请输入<b>任务名称</b>（展示给用户，例如「在群里发一次言」）：`,
    "HTML"
  );
}

// ---------- 引导式：修改字段 ----------
const FIELD_PROMPTS = {
  label: (def) => `当前名称：<b>${escapeHtml(def.label)}</b>\n\n请输入<b>新的任务名称</b>：`,
  hint: (def) => `当前提示：${escapeHtml(def.hint) || "（无）"}\n\n请输入<b>新的完成提示</b>（回复 - 表示清空）：`,
  points: (def) => `当前奖励：<b>+${def.points}</b> 积分\n\n请输入<b>新的奖励积分</b>（1 ~ ${MAX_POINTS}）：`
};

/** 进入「修改某个字段」的引导步骤（名称 / 提示 / 奖励） */
export async function startTaskFieldEdit({ env, token, chatId, taskId, field }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const def = await getTaskDef(env, taskId);
  if (!def) return sendMessage(token, chatId, "❌ 任务不存在。");

  const prompt = FIELD_PROMPTS[field];
  if (!prompt) return sendMessage(token, chatId, "⚠️ 不支持的字段。");

  await setSession(env, chatId, `edit:${field}`, def.id, null);

  return sendMessage(
    token, chatId,
    `✏️ <b>修改任务 #${def.id}</b>\n-------------------------\n` + prompt(def) +
    `\n\n（回复 <code>/cancel</code> 取消）`,
    "HTML"
  );
}

/** 全勤奖：当天所有启用任务都完成后额外发放的积分 */
export async function startTaskBonusEdit({ env, token, chatId }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const bonus = await getTaskBonus(env);
  await setSession(env, chatId, "bonus", null, null);

  return sendMessage(
    token, chatId,
    `🏆 <b>修改全勤奖</b>\n-------------------------\n` +
    `当前全勤奖：<b>${bonus}</b> 积分\n` +
    `（当天所有启用的任务都完成后额外发放）\n\n` +
    `请输入<b>新的全勤奖积分</b>（0 ~ ${MAX_POINTS}，0 表示不发）：\n\n` +
    `（回复 <code>/cancel</code> 取消）`,
    "HTML"
  );
}

// ---------- 引导式文本输入的总入口 ----------
/** 管理员是否正处在任务引导流程中（过期会话视为无） */
export async function isTaskGuideActive(env, chatId) {
  if (!env.DB) return false;
  return Boolean(await getSession(env, chatId));
}

/** /cancel 或「取消」按钮：结束引导 */
export async function cancelTaskGuide({ env, token, chatId }) {
  if (env.DB) await clearSession(env, chatId);
  return sendMessage(token, chatId, "🚫 已取消每日任务编辑。");
}

/**
 * 处理引导流程里的文本输入。
 * @returns {Promise<boolean>} 是否已经消费这条消息
 */
export async function handleTaskGuideInput({ env, token, chatId, userText, adminId = null }) {
  if (!env.DB) return false;

  const session = await getSession(env, chatId);
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  const step = String(session.step || "");
  const draft = parseDraft(session.draft);

  // ---- 添加：任务名称 → 提示 → 奖励 ----
  if (step === "add:label") {
    draft.label = text.slice(0, 40);
    await setSession(env, chatId, "add:hint", null, draft);
    await sendMessage(
      token, chatId,
      `✅ 名称已记录：<b>${escapeHtml(draft.label)}</b>\n\n` +
      `请输入<b>完成提示</b>（告诉用户怎么做，例如「发送 /checkin」；回复 - 表示不填）：`,
      "HTML"
    );
    return true;
  }

  if (step === "add:hint") {
    draft.hint = text === "-" ? "" : text.slice(0, 80);
    await setSession(env, chatId, "add:points", null, draft);
    await sendMessage(token, chatId, `✅ 提示已记录。\n\n请输入<b>完成奖励积分</b>（1 ~ ${MAX_POINTS}）：`);
    return true;
  }

  if (step === "add:points") {
    const points = Number.parseInt(text, 10);
    if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
      await sendMessage(token, chatId, `⚠️ 奖励需要是 1 ~ ${MAX_POINTS} 之间的整数，请重新输入：`);
      return true;
    }

    const res = await createTaskDef(env, { trigger: draft.trigger, label: draft.label, hint: draft.hint, points });
    await clearSession(env, chatId);

    if (!res.ok) {
      await sendMessage(token, chatId, `❌ 创建失败：${res.error}`);
      return true;
    }

    await sendMessage(
      token, chatId,
      `🎉 <b>任务已创建</b>\n-------------------------\n` +
      `✅ <b>${escapeHtml(res.label)}</b>\n` +
      `⚡ 触发：${escapeHtml(triggerLabel(res.trigger))}\n` +
      `🎁 奖励：+${res.points} 积分\n\n` +
      `用户可以用 /tasks 查看今天的任务。`,
      "HTML"
    );
    await logAdminAction(env, { adminId, chatId, action: "task_create", detail: `#${res.id} ${res.label} +${res.points}` });
    // 新任务排在最后，直接跳到最后一页，管理员能立刻看到它
    const allDefs = await listTaskDefs(env);
    await renderTaskAdmin(token, env, chatId, null, pageOfTask(allDefs, res.id));
    return true;
  }

  // ---- 修改字段 ----
  if (step.startsWith("edit:")) {
    const field = step.slice("edit:".length);
    const taskId = Number(session.task_id);
    let value;

    if (field === "points") {
      const points = Number.parseInt(text, 10);
      if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
        await sendMessage(token, chatId, `⚠️ 奖励需要是 1 ~ ${MAX_POINTS} 之间的整数，请重新输入：`);
        return true;
      }
      value = points;
    } else if (field === "hint") {
      value = text === "-" ? "" : text.slice(0, 80);
    } else {
      value = text.slice(0, 40);
    }

    const res = await updateTaskDef(env, taskId, { [field]: value });
    await clearSession(env, chatId);

    if (!res.ok) {
      await sendMessage(token, chatId, `❌ 修改失败：${res.error}`);
      return true;
    }

    await sendMessage(token, chatId, "✅ 修改成功。");
    await logAdminAction(env, { adminId, chatId, action: "task_update", detail: `#${taskId} ${field} → ${value}` });
    await renderTaskDetail(token, env, chatId, null, taskId);
    return true;
  }

  // ---- 全勤奖 ----
  if (step === "bonus") {
    const points = Number.parseInt(text, 10);
    if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
      await sendMessage(token, chatId, `⚠️ 全勤奖需要是 0 ~ ${MAX_POINTS} 之间的整数，请重新输入：`);
      return true;
    }

    await setTaskBonus(env, points);
    await clearSession(env, chatId);
    await sendMessage(token, chatId, `✅ 全勤奖已设置为 <b>${points}</b> 积分。`, "HTML");
    await logAdminAction(env, { adminId, chatId, action: "task_bonus", detail: `${points}` });
    await renderTaskAdmin(token, env, chatId, null);
    return true;
  }

  // 未知步骤：清掉，交回给正常流程
  await clearSession(env, chatId);
  return false;
}

// ---------- 启用 / 停用 / 删除 ----------
/** 启用 / 停用任务（停用后不再参与结算，已有进度保留） */
export async function handleTaskToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const taskId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.TASK_TOGGLE_PREFIX, ""), 10);
  if (!Number.isInteger(taskId)) return;

  const def = await getTaskDef(env, taskId);
  if (!def) {
    await answerCallback(token, callback.id, "❌ 任务不存在", true);
    return;
  }

  const next = Number(def.enabled) !== 1;
  await updateTaskDef(env, taskId, { enabled: next });
  await logAdminAction(env, {
    adminId, chatId, action: next ? "task_enable" : "task_disable", detail: `#${taskId} ${def.label}`
  });

  await answerCallback(token, callback.id, next ? "✅ 已启用" : "🚫 已停用");
  await renderTaskDetail(token, env, chatId, msgId, taskId);
}

/** 删除前先二次确认 */
export async function handleTaskDelete({ env, token, callback, chatId, msgId, data }) {
  const taskId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.TASK_DEL_PREFIX, ""), 10);
  if (!Number.isInteger(taskId)) return;

  const def = await getTaskDef(env, taskId);
  if (!def) {
    await answerCallback(token, callback.id, "❌ 任务不存在", true);
    return;
  }

  await answerCallback(token, callback.id, "请确认删除", false);
  await editMessageText(
    token, chatId, msgId,
    `🗑️ <b>确认删除任务？</b>\n-------------------------\n` +
    `✅ <b>${escapeHtml(def.label)}</b>（+${def.points}）\n\n` +
    `删除后用户今天已获得的进度记录会保留，但该任务不再出现在 /tasks 里。`,
    {
      inline_keyboard: [
        [{ text: "🗑️ 确认删除", callback_data: `${ADMIN_CALLBACK.TASK_DELOK_PREFIX}${def.id}` }],
        [{ text: "🔙 再想想", callback_data: `${ADMIN_CALLBACK.TASK_DETAIL_PREFIX}${def.id}` }]
      ]
    },
    "HTML"
  );
}

/** 确认删除：只删任务定义，用户当天已获得的积分与进度记录保留 */
export async function handleTaskDeleteConfirm({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const taskId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.TASK_DELOK_PREFIX, ""), 10);
  if (!Number.isInteger(taskId)) return;

  const def = await getTaskDef(env, taskId);
  const ok = await deleteTaskDef(env, taskId);

  await answerCallback(token, callback.id, ok ? "🗑️ 已删除" : "❌ 任务不存在", !ok);
  await logAdminAction(env, {
    adminId, chatId, action: "task_delete", detail: `#${taskId} ${def?.label || ""}`
  });
  await renderTaskAdmin(token, env, chatId, msgId);
}
