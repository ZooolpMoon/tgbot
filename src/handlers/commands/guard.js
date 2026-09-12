// ==========================================
// 📜 /guard：群规执法面板
//
// 与「管理控制台 → 📜 群规执法」是同一个面板：
// 引导式编辑群规、设置默认处置与禁言时长、开关执法、查看处置记录。
// 群规是按群的，所以请在目标群里使用。
// ==========================================

import { renderGuardPanel } from "../../admin/guard-panel.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { handleAppealRequest, handleReportRequest } from "../../admin/guard.js";

/** /guard：打开群规执法面板 */
export async function cmdGuard({ env, token, chatId, uctx, isGroupCtx, ctx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }
  // 面板要长期停留在会话里，所以用新消息而不是自动删除
  await renderGuardPanel(token, env, chatId, null, uctx);
}

/**
 * /report <理由>：群成员举报（必须先回复违规的那条消息）。
 * 理由校验通过后，确认卡片会发到管理员私聊，由管理员决定是否处置。
 */
export async function cmdReport({ env, ctx, token, chatId, uctx, message, rawText, isGroupCtx, isMaster }) {
  if (!isGroupCtx) {
    await sendAutoDelete(
      token, chatId,
      "📣 举报请在<b>群里</b>使用：先回复违规消息，再发 <code>/report 发广告</code>。",
      "HTML", isGroupCtx, ctx, { kind: "guard", env, sceneKey: uctx?.sceneKey }
    );
    return;
  }
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx, {
      kind: "guard", env, sceneKey: uctx?.sceneKey
    });
    return;
  }

  const handled = await handleReportRequest({
    env, token, chatId, uctx, message, rawText, isMaster, ctx
  });
  if (handled) return;

  // 没被受理的原因只有两种：管理员走执法流程，或本群关闭了群规执法
  await sendAutoDelete(
    token, chatId,
    isMaster
      ? "👑 管理员不用举报，直接用 <code>/ban</code> / <code>/mute</code> 等指令处置即可。"
      : "⚠️ 本群暂未启用群规执法，或执法已被关闭；可以私聊管理员反馈。",
    "HTML", isGroupCtx, ctx, { kind: "guard", env, sceneKey: uctx?.sceneKey }
  );
}

/** /appeal <理由>：被处置人私聊申诉（只针对最近 7 天内作用在自己身上的处置） */
export async function cmdAppeal({ env, ctx, token, chatId, uctx, rawText, isGroupCtx }) {
  if (isGroupCtx) {
    await sendAutoDelete(
      token, chatId,
      "⚠️ 申诉请<b>私聊</b>机器人：<code>/appeal 申诉理由</code>（在群里说会被其他成员看到）。",
      "HTML", isGroupCtx, ctx, { kind: "guard", env, sceneKey: uctx?.sceneKey }
    );
    return;
  }
  await handleAppealRequest({ env, token, chatId, uctx, rawText, ctx });
}
