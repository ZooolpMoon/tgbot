// ==========================================
// ✅ 每日任务服务
// 完成即发奖；四个任务全完成后额外发一次「全勤奖」
// ==========================================

import { DAILY_TASKS, DAILY_TASK_ALL_BONUS, TASK_ALL_KEY } from "../config/tasks.js";
import { getDateKey } from "./time.js";
import { adjustPoints, logPointChange } from "./points.js";
import { isFeatureEnabled } from "./features.js";
import { sendMessage } from "../telegram/api.js";
import { logError } from "../core/logger.js";

export const TASK_KEYS = DAILY_TASKS.map((t) => t.key);

export function taskDef(key) {
  return DAILY_TASKS.find((t) => t.key === key) || null;
}

/**
 * 今日任务进度。
 * @returns {Promise<{tasks: Array, done: number, total: number, earned: number, allDone: boolean, bonus: number}>}
 */
export async function getTodayTasks(env, userKey) {
  const total = DAILY_TASKS.length;
  if (!env.DB) {
    return {
      tasks: DAILY_TASKS.map((t) => ({ ...t, done: false })),
      done: 0, total, earned: 0, allDone: false, bonus: DAILY_TASK_ALL_BONUS
    };
  }

  const today = getDateKey(env);
  const { results } = await env.DB.prepare(
    "SELECT task, points FROM daily_tasks WHERE user_key = ? AND date_str = ?"
  ).bind(userKey, today).all();

  const rows = results || [];
  const doneMap = new Map(rows.map((r) => [String(r.task), Number(r.points) || 0]));

  const tasks = DAILY_TASKS.map((t) => ({ ...t, done: doneMap.has(t.key) }));
  const done = tasks.filter((t) => t.done).length;
  const earned = rows.reduce((sum, r) => sum + (Number(r.points) || 0), 0);

  return { tasks, done, total, earned, allDone: done >= total, bonus: DAILY_TASK_ALL_BONUS };
}

/**
 * 标记任务完成并立即发奖。
 * - 重复调用只会生效一次（主键 + INSERT OR IGNORE）
 * - 全部完成时追加一次全勤奖，并给用户发一条祝贺消息
 *
 * @param {object} opts
 * @param {string} [opts.sceneKey] 用于判断该场景是否关闭了「每日任务」
 * @param {string} [opts.chatId]   全部完成时发消息用
 * @param {string} [opts.token]    Telegram token
 */
export async function completeTask(env, userKey, taskKey, { sceneKey = null, chatId = null, token = null } = {}) {
  const def = taskDef(taskKey);
  if (!env.DB || !userKey || !def) return { completed: false };

  // 场景关闭了每日任务就不再累计
  if (sceneKey && !(await isFeatureEnabled(env, sceneKey, "tasks"))) {
    return { completed: false, disabled: true };
  }

  const today = getDateKey(env);

  let first = false;
  try {
    const res = await env.DB.prepare(`
      INSERT INTO daily_tasks (user_key, date_str, task, points)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_key, date_str, task) DO NOTHING
    `).bind(userKey, today, taskKey, def.points).run();
    first = res.meta.changes > 0;
  } catch (e) {
    logError("记录每日任务失败：", e);
    return { completed: false };
  }

  if (!first) return { completed: false, alreadyDone: true };

  let balance = await adjustPoints(env, userKey, def.points);
  if (balance !== null) {
    await logPointChange(env, userKey, def.points, balance, `每日任务：${def.label}`);
  }

  // 是否全部完成
  const progress = await getTodayTasks(env, userKey);
  let bonus = 0;
  let allDone = false;

  if (progress.allDone) {
    try {
      const bonusRes = await env.DB.prepare(`
        INSERT INTO daily_tasks (user_key, date_str, task, points)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_key, date_str, task) DO NOTHING
      `).bind(userKey, today, TASK_ALL_KEY, DAILY_TASK_ALL_BONUS).run();

      if (bonusRes.meta.changes > 0) {
        allDone = true;
        bonus = DAILY_TASK_ALL_BONUS;
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

  // 全勤时给用户一条祝贺（每天最多一条）
  if (allDone && token && chatId) {
    try {
      await sendMessage(
        token, chatId,
        `🎉 <b>今日任务全部完成！</b>\n` +
        `-------------------------\n` +
        `✅ 任务奖励：+${progress.tasks.reduce((n, t) => n + t.points, 0)}\n` +
        `🎁 全勤奖励：+${bonus}\n` +
        `🪙 当前积分：<b>${balance ?? "?"}</b>\n\n` +
        `明天记得再来～`,
        "HTML"
      );
    } catch (e) {
      logError("发送任务完成祝贺失败：", e);
    }
  }

  return { completed: true, points: def.points, bonus, allDone, balance };
}
