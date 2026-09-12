// ==========================================
// ✅ /tasks 每日任务
// 展示今日任务清单与完成进度（任务定义由管理员在控制台维护）。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { getTodayTasks } from "../../services/tasks.js";

/** /tasks 指令实现 */
export async function cmdTasks({ env, ctx, token, chatId, userKey, isGroupCtx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库，每日任务不可用。", null, isGroupCtx, ctx);
    return;
  }

  const { tasks, done, total, earned, allDone, bonus } = await getTodayTasks(env, userKey);

  let text = `✅ <b>每日任务</b>\n`;
  text += `-------------------------\n`;
  text += `📅 <b>今日进度：</b> ${done} / ${total}\n`;
  text += `🪙 <b>今日已得：</b> ${earned} 积分\n\n`;

  for (const task of tasks) {
    text += `${task.done ? "✅" : "⬜️"} <b>${task.label}</b> · +${task.points}\n`;
    if (!task.done) text += `    └ ${task.hint}\n`;
  }

  text += `\n${allDone
    ? `🎉 今日任务已全部完成，全勤奖 +${bonus} 已发放，明天再来～`
    : `🎁 全部完成额外奖励 <b>+${bonus}</b> 积分`}`;

  // 群聊里属于「指令类消息」，交给通用自动删除逻辑
  await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx);
}
