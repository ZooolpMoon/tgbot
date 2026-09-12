// ==========================================
// 🛠️ 场景编辑面板 + 删除场景
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getDateKey } from "../services/time.js";
import { escapeHtml } from "../utils/html.js";
import { setUserBlocked } from "../services/users.js";
import { logAdminAction } from "../services/admin-log.js";

export async function renderUserEditMenu(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;

  const scene = await env.DB.prepare(`
    SELECT s.id, s.scene_key, s.user_key, s.user_id, s.chat_id, s.chat_type,
           s.username, s.first_name, s.lang, s.custom_prompt,
           s.max_daily, s.rate_limit_sec, s.updated_at,
           COALESCE(u.points, 0) AS points,
           COALESCE(u.blocked, 0) AS blocked
    FROM user_scenes s
    LEFT JOIN users u ON u.user_key = s.user_key
    WHERE s.id = ?
  `).bind(rowId).first();

  if (!scene) {
    const text = `❌ 场景 #${rowId} 未找到或已被删除。`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 返回用户列表", callback_data: "admin_users_private_1" }]] };
    return editMessageText(token, chatId, messageId, text, keyboard);
  }

  const todayStr = getDateKey(env);
  const dailyRow = await env.DB.prepare(
    "SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?"
  ).bind(scene.scene_key, todayStr).first();
  const todayCount = Number.isFinite(Number(dailyRow?.count)) ? Math.max(0, Math.floor(Number(dailyRow.count))) : 0;

  const rawMaxDaily = scene.max_daily;
  const pmd = Number(rawMaxDaily);
  let maxDaily;
  if (rawMaxDaily === null || rawMaxDaily === undefined || rawMaxDaily === "" || !Number.isFinite(pmd)) maxDaily = 50;
  else if (pmd === -1) maxDaily = -1;
  else maxDaily = Math.max(0, Math.floor(pmd));

  const limitDisplay = maxDaily === -1 ? `已用 ${todayCount} 条 (不限额)` : `${todayCount} / ${maxDaily} 条`;
  const pts = Number.isFinite(Number(scene.points)) ? Number(scene.points) : 0;
  const rate = Number.isFinite(Number(scene.rate_limit_sec)) ? Math.max(0, Math.floor(Number(scene.rate_limit_sec))) : 5;
  const blocked = Number(scene.blocked) === 1;

  const sourceText = (scene.chat_type === "group" || scene.chat_type === "supergroup")
    ? `👥 群聊成员 (群: <code>${escapeHtml(scene.chat_id)}</code>)`
    : `💬 私聊用户`;

  const text =
    `🛠️ <b>场景编辑面板</b>\n` +
    `-------------------------\n` +
    `🔢 <b>场景行 ID:</b> <code>${scene.id}</code>\n` +
    `🧩 <b>场景键:</b> <code>${escapeHtml(scene.scene_key)}</code>\n` +
    `💰 <b>全局积分键:</b> <code>${escapeHtml(scene.user_key)}</code>\n` +
    `🆔 <b>用户 ID:</b> <code>${escapeHtml(scene.user_id)}</code>\n` +
    `📍 <b>来源:</b> ${sourceText}\n` +
    `👤 <b>名字:</b> ${escapeHtml(scene.first_name) || "未命名"}\n` +
    `🏷️ <b>用户名:</b> ${escapeHtml(scene.username) || "无用户名"}\n` +
    `🚦 <b>账号状态:</b> ${blocked ? "🚫 已封禁" : "✅ 正常"}\n` +
    `🪙 <b>全局积分（跨场景共享）:</b> <b>${pts}</b>\n` +
    `📅 <b>本场景今日限额:</b> ${limitDisplay}\n` +
    `⏱️ <b>本场景频率限制:</b> ${rate} 秒/条\n` +
    `🌐 <b>语言偏好:</b> ${scene.lang || "zh"}\n` +
    `📝 <b>自定义 prompt:</b> ${escapeHtml(scene.custom_prompt) || "无"}\n` +
    `🕒 <b>最后更新:</b> ${scene.updated_at || "未知"}\n\n` +
    `<b>请选择您要进行的管理操作：</b>`;

  const backTarget = (scene.chat_type === "group" || scene.chat_type === "supergroup")
    ? "admin_users_group_1"
    : "admin_users_private_1";

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🪙 快速增减积分（全局）", callback_data: `admin_menu_pts_${scene.id}` },
        { text: "📜 查看积分流水", callback_data: `admin_log_pts_${scene.id}_1` }
      ],
      [
        { text: "📅 管理本场景限额", callback_data: `admin_menu_limit_${scene.id}` },
        { text: "⏱️ 管理本场景频率", callback_data: `admin_menu_rate_${scene.id}` }
      ],
      [
        {
          text: blocked ? "✅ 解封此用户" : "🚫 封禁此用户",
          callback_data: `admin_block_${scene.id}`
        },
        { text: "🧹 清空此场景记忆", callback_data: `admin_clearmem_${scene.id}` }
      ],
      [
        { text: "🧩 本场景功能开关", callback_data: `admin_feat_s_${scene.id}` }
      ],
      [
        { text: "🗑️ 删除此场景（积分保留）", callback_data: `admin_deluser_confirm_${scene.id}` }
      ],
      [{ text: "🔙 返回场景列表", callback_data: backTarget }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

export async function handleDeleteScene({ env, token, callback, chatId, msgId, data, renderUserListMenu, adminId = null }) {
  const rowId = parseInt(data.replace("admin_deluser_confirm_", ""), 10);
  if (!env.DB || !Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare(
    "SELECT id, scene_key, user_key, chat_type, user_id, first_name FROM user_scenes WHERE id = ?"
  ).bind(rowId).first();

  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_scenes WHERE id = ?").bind(rowId),
    env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(scene.scene_key),
    env.DB.prepare("DELETE FROM daily_stats WHERE scene_key = ?").bind(scene.scene_key)
  ]);

  const backType = (scene.chat_type === "group" || scene.chat_type === "supergroup") ? "group" : "private";
  await answerCallback(token, callback.id, `🗑️ 场景 #${rowId} 已删除（全局积分保留）`);

  await logAdminAction(env, {
    adminId, chatId,
    action: "scene_delete",
    detail: `#${rowId} ${scene.scene_key}（用户 ${scene.user_id || scene.user_key}）`
  });

  await renderUserListMenu(token, env, chatId, msgId, 1, backType);
}

// ==========================================
// 🚫 封禁 / 解封用户
// ==========================================

export async function handleToggleBlock({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rowId = parseInt(data.replace("admin_block_", ""), 10);
  if (!env.DB || !Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare(
    "SELECT id, user_key, user_id, first_name FROM user_scenes WHERE id = ?"
  ).bind(rowId).first();

  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const cur = await env.DB.prepare("SELECT blocked FROM users WHERE user_key = ?").bind(scene.user_key).first();
  const next = Number(cur?.blocked) === 1 ? false : true;

  await setUserBlocked(env, scene.user_key, next);

  await logAdminAction(env, {
    adminId, chatId,
    action: next ? "user_block" : "user_unblock",
    detail: `${scene.first_name || ""} ${scene.user_key}`
  });

  await answerCallback(
    token, callback.id,
    next ? "🚫 已封禁该用户（所有场景停止服务）" : "✅ 已解封该用户",
    true
  );
  await renderUserEditMenu(token, env, chatId, msgId, rowId);
}

// ==========================================
// 🧹 清空指定场景（某群某用户 / 私聊）的 AI 记忆
// ==========================================

export async function handleClearSceneMemory({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const rowId = parseInt(data.replace("admin_clearmem_", ""), 10);
  if (!env.DB || !Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare(
    "SELECT id, scene_key, chat_type, chat_id, user_id FROM user_scenes WHERE id = ?"
  ).bind(rowId).first();

  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const res = await env.DB.prepare(
    "DELETE FROM chat_history WHERE scene_key = ?"
  ).bind(scene.scene_key).run();

  await logAdminAction(env, {
    adminId, chatId,
    action: "scene_clear_memory",
    detail: `#${rowId} ${scene.scene_key}（删除 ${res.meta.changes} 条记忆）`
  });

  await answerCallback(
    token, callback.id,
    res.meta.changes > 0
      ? `🧹 已清除该场景的对话记忆（${scene.scene_key}）`
      : `ℹ️ 该场景本来就没有对话记忆（${scene.scene_key}）`,
    true
  );
  await renderUserEditMenu(token, env, chatId, msgId, rowId);
}
