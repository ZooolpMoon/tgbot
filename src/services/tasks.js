// ==========================================
// ✅ 每日任务服务（v2.1.0：任务定义存数据库，可引导式增删改）
//
// 任务 = 触发条件(trigger) + 文案 + 奖励
// 机器人只能观测到有限的几种行为，所以 trigger 由代码定义
// （见 config/tasks.js 的 TASK_TRIGGERS），管理员可基于它自由增删任务。
// ==========================================

import { TASK_TRIGGERS, TRIGGER_KEYS, triggerDef, triggerLabel, DEFAULT_TASK_BONUS, TASK_BONUS_SETTING, TASK_ALL_KEY } from "../config/tasks.js";
import { getDateKey } from "./time.js";
import { getSetting, setSetting } from "./settings.js";
import { adjustPoints, logPointChange } from "./points.js";
import { isFeatureEnabled } from "./features.js";
import { sendMessage } from "../telegram/api.js";
import { logError } from "../core/logger.js";

const MAX_POINTS = 1000;

/** 没有数据库时的兜底定义（只用于展示） */
function fallbackDefs() {
  return TASK_TRIGGERS.map((t, i) => ({
    id: i + 1, trigger: t.key, label: t.label, hint: t.hint, points: t.points, enabled: 1, sort_order: i + 1
  }));
}

/** 全部任务定义（默认按 sort_order 排序） */
export async function listTaskDefs(env) {
  if (!env.DB) return fallbackDefs();
  const { results } = await env.DB.prepare(
    "SELECT id, trigger, label, hint, points, enabled, sort_order FROM daily_task_defs ORDER BY sort_order ASC, id ASC"
  ).all();
  return results || [];
}

/** 只取启用的任务 */
export async function getEnabledTaskDefs(env) {
  const all = await listTaskDefs(env);
  return all.filter((d) => Number(d.enabled) === 1);
}

/** 读取单个任务定义（不存在返回 null） */
export async function getTaskDef(env, id) {
  if (!env.DB) return null;
  return env.DB.prepare(
    "SELECT id, trigger, label, hint, points, enabled, sort_order FROM daily_task_defs WHERE id = ?"
  ).bind(id).first();
}

// ==========================================
// 全勤奖设置
// ==========================================

/** 读取全勤奖积分数（全局设置，非法值回退默认） */
export async function getTaskBonus(env) {
  const raw = await getSetting(env, TASK_BONUS_SETTING, String(DEFAULT_TASK_BONUS));
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TASK_BONUS;
}

/** 设置全勤奖积分数，范围 0 ~ MAX_POINTS，0 表示不发 */
export async function setTaskBonus(env, points) {
  const n = Math.floor(Number(points));
  if (!Number.isFinite(n) || n < 0 || n > MAX_POINTS) return false;
  await setSetting(env, TASK_BONUS_SETTING, n);
  return true;
}

// ==========================================
// 进度查询
// ==========================================

/** 查询某用户今天的任务完成情况（没有数据库时返回尚未完成的默认视图） */
export async function getTodayTasks(env, userKey) {
  const defs = await getEnabledTaskDefs(env);
  const bonus = await getTaskBonus(env);

  if (!env.DB) {
    return {
      tasks: defs.map((d) => ({ ...d, done: false })),
      done: 0, total: defs.length, earned: 0, allDone: false, bonus
    };
  }

  const today = getDateKey(env);
  const { results } = await env.DB.prepare(
    "SELECT task, points FROM daily_tasks WHERE user_key = ? AND date_str = ?"
  ).bind(userKey, today).all();

  const rows = results || [];
  const doneMap = new Map(rows.map((r) => [String(r.task), Number(r.points) || 0]));
  const tasks = defs.map((d) => ({ ...d, done: doneMap.has(`t${d.id}`) }));
  const done = tasks.filter((t) => t.done).length;
  const earned = rows.reduce((sum, r) => sum + (Number(r.points) || 0), 0);

  return {
    tasks, done, total: tasks.length, earned,
    allDone: tasks.length > 0 && done >= tasks.length,
    bonus
  };
}

// ==========================================
// 完成任务（按触发条件）
// ==========================================

/**
 * 触发某个行为：把所有绑定该触发条件的启用任务一起结算。
 * 重复调用同一天只会发奖一次（主键 + INSERT OR IGNORE）。
 *
 * @param {string} trigger checkin / chat / game / shop / redeem
 * @param {{sceneKey?: string, chatId?: string, token?: string}} [opts]
 *        sceneKey 用于判断该场景是否关掉了「每日任务」；chatId/token 用于发祝贺消息
 */
export async function completeTask(env, userKey, trigger, { sceneKey = null, chatId = null, token = null } = {}) {
  if (!env.DB || !userKey || !TRIGGER_KEYS.includes(trigger)) return { completed: false };

  // 该场景关掉了每日任务就不再累计
  if (sceneKey && !(await isFeatureEnabled(env, sceneKey, "tasks"))) {
    return { completed: false, disabled: true };
  }

  const defs = (await getEnabledTaskDefs(env)).filter((d) => String(d.trigger) === trigger);
  if (defs.length === 0) return { completed: false };

  const today = getDateKey(env);
  const labels = [];
  let earned = 0;

  for (const def of defs) {
    let first = false;
    try {
      const res = await env.DB.prepare(`
        INSERT INTO daily_tasks (user_key, date_str, task, points)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_key, date_str, task) DO NOTHING
      `).bind(userKey, today, `t${def.id}`, def.points).run();
      first = res.meta.changes > 0;
    } catch (e) {
      logError("记录每日任务失败：", e);
      continue;
    }
    if (!first) continue;

    const balance = await adjustPoints(env, userKey, def.points);
    if (balance !== null) {
      await logPointChange(env, userKey, def.points, balance, `每日任务：${def.label}`);
    }
    labels.push(def.label);
    earned += Number(def.points) || 0;
  }

  if (earned === 0) return { completed: false, alreadyDone: true };

  // 判断是否全勤（启用任务全部完成）
  const progress = await getTodayTasks(env, userKey);
  let bonus = 0;
  let allDone = false;
  let balance = null;

  if (progress.allDone && progress.bonus > 0) {
    try {
      const bonusRes = await env.DB.prepare(`
        INSERT INTO daily_tasks (user_key, date_str, task, points)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_key, date_str, task) DO NOTHING
      `).bind(userKey, today, TASK_ALL_KEY, progress.bonus).run();

      if (bonusRes.meta.changes > 0) {
        allDone = true;
        bonus = progress.bonus;
        const after = await adjustPoints(env, userKey, bonus);
        if (after !== null) {
          await logPointChange(env, userKey, bonus, after, "每日任务：全部完成奖励");
          balance = after;
        }
      }
    } catch (e) {
      logError("发放每日任务全勤奖失败：", e);
    }
  }

  if (allDone && token && chatId) {
    try {
      await sendMessage(
        token, chatId,
        `🎉 <b>今日任务全部完成！</b>\n` +
        `-------------------------\n` +
        `✅ 本次任务奖励：+${earned}\n` +
        `🎁 全勤奖励：+${bonus}\n` +
        `🪙 当前积分：<b>${balance ?? "?"}</b>\n\n` +
        `明天记得再来～`,
        "HTML"
      );
    } catch (e) {
      logError("发送任务完成祝贺失败：", e);
    }
  }

  return { completed: true, points: earned, labels, bonus, allDone, balance };
}

// ==========================================
// 管理端 CRUD
// ==========================================

/**
 * 新建任务定义（管理员引导式添加的落库入口）。
 * 触发条件必须是代码里已定义的 TASK_TRIGGERS，名称与奖励做了范围校验。
 */
export async function createTaskDef(env, { trigger, label, hint = "", points = 1 }) {
  if (!env.DB) return { ok: false, error: "未绑定数据库" };
  if (!TRIGGER_KEYS.includes(String(trigger))) return { ok: false, error: "未知的触发条件" };

  const name = String(label || "").trim().slice(0, 40);
  if (!name) return { ok: false, error: "任务名称不能为空" };

  const pts = Math.floor(Number(points));
  if (!Number.isFinite(pts) || pts <= 0 || pts > MAX_POINTS) {
    return { ok: false, error: `奖励积分需在 1 ~ ${MAX_POINTS} 之间` };
  }

  const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM daily_task_defs").first();
  const sortOrder = (Number(maxRow?.n) || 0) + 1;

  const res = await env.DB.prepare(`
    INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
    VALUES (?, ?, ?, ?, 1, ?)
  `).bind(trigger, name, String(hint || "").trim().slice(0, 80), pts, sortOrder).run();

  return { ok: true, id: Number(res.meta.last_row_id), label: name, trigger, points: pts };
}

/** 修改任务定义；只更新传入的字段（label / hint / points / enabled） */
export async function updateTaskDef(env, id, fields = {}) {
  if (!env.DB) return { ok: false, error: "未绑定数据库" };

  const def = await getTaskDef(env, id);
  if (!def) return { ok: false, error: "任务不存在" };

  const sets = [];
  const values = [];

  if (fields.label !== undefined) {
    const label = String(fields.label).trim().slice(0, 40);
    if (!label) return { ok: false, error: "任务名称不能为空" };
    sets.push("label = ?"); values.push(label);
  }
  if (fields.hint !== undefined) {
    sets.push("hint = ?"); values.push(String(fields.hint).trim().slice(0, 80));
  }
  if (fields.points !== undefined) {
    const pts = Math.floor(Number(fields.points));
    if (!Number.isFinite(pts) || pts <= 0 || pts > MAX_POINTS) {
      return { ok: false, error: `奖励积分需在 1 ~ ${MAX_POINTS} 之间` };
    }
    sets.push("points = ?"); values.push(pts);
  }
  if (fields.enabled !== undefined) {
    sets.push("enabled = ?"); values.push(fields.enabled ? 1 : 0);
  }
  if (sets.length === 0) return { ok: false, error: "没有需要更新的字段" };

  sets.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  await env.DB.prepare(`UPDATE daily_task_defs SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
  return { ok: true };
}

/** 删除任务定义（用户已有的当日进度记录会保留，只是不再展示） */
export async function deleteTaskDef(env, id) {
  if (!env.DB) return false;
  const res = await env.DB.prepare("DELETE FROM daily_task_defs WHERE id = ?").bind(id).run();
  return res.meta.changes > 0;
}

export { triggerLabel, triggerDef };
