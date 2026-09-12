// ==========================================
// 📚 知识库管理（RAG）
//
// 入口：管理员控制台 → 📚 知识库
// 作用域规则（不需要额外状态，靠会话类型自动判定）：
//   • 在**私聊**里打开 → 管理「🌍 全局知识库」（所有场景都能检索到）
//   • 在**群聊**里打开 → 管理「👥 本群知识库」（只有这个群能检索到）
// 两种库在检索时会一起参与，本群命中的资料优先。
//
// 添加文档有两种方式：
//   1. 引导式：输入标题 → 粘贴正文
//   2. 直接上传 .txt / .md 文件（见 handlers/message.js 的文档分支）
// ==========================================

import {
  sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback, getFile, downloadFileText
} from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, pagerRow, pageInfoText, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK, KB } from "../config/constants.js";
import { buildGroupScopeKey } from "../core/context.js";
import {
  KB_GLOBAL_SCOPE, ingestDocument, listDocuments, getDocument,
  setDocumentEnabled, deleteDocument, kbStats, searchKnowledge
} from "../services/knowledge.js";
import { logAdminAction } from "../services/admin-log.js";
import { logError } from "../core/logger.js";

const DOCS_PER_PAGE = 6;
/** 引导会话有效期：超过则不再拦截普通消息（与商品/任务引导保持一致） */
const SESSION_TTL_MINUTES = 30;
/** 允许上传的文本类扩展名 */
const ALLOWED_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yml", ".yaml"];

// ==========================================
// 作用域
// ==========================================

/**
 * 由会话类型决定当前知识库作用域。
 * @returns {{scopeKey:string, isGroup:boolean, label:string}}
 */
export function resolveKbScope(uctx) {
  const chatType = String(uctx?.chatType || "private");
  const isGroup = chatType === "group" || chatType === "supergroup";
  if (isGroup) {
    return {
      scopeKey: buildGroupScopeKey(uctx.chatId),
      isGroup: true,
      label: `👥 本群知识库（群 ${uctx.chatId}）`
    };
  }
  return { scopeKey: KB_GLOBAL_SCOPE, isGroup: false, label: "🌍 全局知识库" };
}

// ==========================================
// 引导会话（kb_sessions）
// ==========================================

async function setSession(env, chatId, step, draft = null) {
  await env.DB.prepare(`
    INSERT INTO kb_sessions (chat_id, step, draft, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      step = EXCLUDED.step, draft = EXCLUDED.draft, updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, step, draft ? JSON.stringify(draft) : "").run();
}

/** 读取未过期的会话；过期视为不存在（由定时任务清理） */
async function getSession(env, chatId) {
  if (!env?.DB || !chatId) return null;
  return env.DB.prepare(
    `SELECT * FROM kb_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM kb_sessions WHERE chat_id = ?").bind(chatId).run();
}

/** 安全解析草稿 JSON */
function parseDraft(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 管理员是否正在知识库引导流程里（添加文档 / 检索测试） */
export async function isKnowledgeGuideActive(env, chatId) {
  if (!env?.DB) return false;
  return Boolean(await getSession(env, chatId));
}

/** 取消引导 */
export async function cancelKnowledgeGuide({ env, token, chatId }) {
  if (env.DB) await clearSession(env, chatId);
  return sendMessage(token, chatId, "🚫 已取消知识库操作。");
}

// ==========================================
// 面板：首页 / 文档列表 / 文档详情
// ==========================================

/** 知识库首页键盘（纯函数，便于排版测试） */
export function getKnowledgeHomeKeyboard() {
  return {
    inline_keyboard: [
      ...grid([
        { text: "➕ 添加文档", callback_data: ADMIN_CALLBACK.KB_ADD },
        { text: "📄 文档列表", callback_data: `${ADMIN_CALLBACK.KB_LIST_PREFIX}1` }
      ]),
      [{ text: "🔍 检索测试", callback_data: ADMIN_CALLBACK.KB_TEST }],
      [{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]
    ]
  };
}

/** 知识库首页：当前作用域 + 容量 + 使用说明 */
export async function renderKnowledgeHome(token, env, chatId, messageId, uctx) {
  if (!env.DB) {
    const text = "❌ 未绑定数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const scope = resolveKbScope(uctx);
  const stats = await kbStats(env, scope.scopeKey);
  const model = env.KB_EMBED_MODEL ? String(env.KB_EMBED_MODEL) : KB.EMBED_MODEL;
  const aiReady = Boolean(env.AI);

  let text = `📚 <b>知识库</b>\n`;
  text += `当前作用域：<b>${scope.label}</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `📄 文档：<b>${stats.docs}</b> 篇 · 🧩 分块：<b>${stats.chunks}</b> / ${KB.MAX_TOTAL_CHUNKS}\n`;
  text += `🤖 向量模型：<code>${escapeHtml(model)}</code>${aiReady ? "" : "（⚠️ 未绑定 Workers AI，将退化为关键词检索）"}\n\n`;
  text += `用户提问时，AI 会先检索这里的资料再回答。\n`;
  text += scope.isGroup
    ? `💡 这里管理的是<b>本群</b>知识库；想管理全局知识库，请在<b>私聊</b>里打开 /admin。\n`
    : `💡 全局知识库对所有私聊与群聊生效；想给某个群单独加资料，请在<b>群里</b>打开 /admin。\n`;
  text += `\n📥 添加方式：引导式粘贴文本，或直接发送 <code>.txt</code> / <code>.md</code> 文件。`;

  const keyboard = getKnowledgeHomeKeyboard();
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 文档列表键盘（纯函数，便于排版测试） */
export function getDocumentListKeyboard(rows, safePage, totalPages) {
  const buttons = rows.map((doc) => ({
    text: compactLabel(`${Number(doc.enabled) === 1 ? "✅" : "🚫"} ${doc.title} · 🧩${doc.chunk_count}`, 30),
    callback_data: `${ADMIN_CALLBACK.KB_DOC_PREFIX}${doc.id}`
  }));

  const inline_keyboard = grid(buttons);
  const navRow = pagerRow({ page: safePage, totalPages, prefix: ADMIN_CALLBACK.KB_LIST_PREFIX });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回知识库", callback_data: ADMIN_CALLBACK.KB_HOME }]);
  return { inline_keyboard };
}

/** 渲染文档列表 */
export async function renderDocumentList(token, env, chatId, messageId, uctx, page = 1) {
  if (!env.DB) {
    const text = "❌ 未绑定数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const scope = resolveKbScope(uctx);
  const listed = await listDocuments(env, scope.scopeKey, page, DOCS_PER_PAGE);
  const safePage = clampPage(listed.page, listed.totalPages);

  let text = `📄 <b>知识库文档</b> · ${scope.label}\n`;
  text += `${pageInfoText({ page: safePage, totalPages: listed.totalPages, total: listed.total, unit: "篇" })}\n`;
  text += `${LAYOUT.DIVIDER}\n`;

  if (listed.rows.length === 0) {
    text += `<i>还没有文档。点「➕ 添加文档」录入，或直接发一个 .txt / .md 文件。</i>\n`;
  } else {
    for (const doc of listed.rows) {
      text += `${Number(doc.enabled) === 1 ? "✅" : "🚫"} <b>${escapeHtml(doc.title)}</b> · 🧩 ${Number(doc.chunk_count) || 0} 块\n`;
      text += `    🕒 ${escapeHtml(doc.updated_at || doc.created_at || "")}${doc.source ? ` · 📎 ${escapeHtml(doc.source)}` : ""}\n`;
    }
  }

  const keyboard = getDocumentListKeyboard(listed.rows, safePage, listed.totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 文档详情：全文预览（截断）+ 启停 / 删除 */
export async function renderDocumentDetail(token, env, chatId, messageId, docId) {
  if (!env.DB) return;

  const doc = await getDocument(env, docId);
  if (!doc) {
    return editMessageText(token, chatId, messageId, "❌ 文档不存在（可能已被删除）。",
      { inline_keyboard: [[{ text: "🔙 返回文档列表", callback_data: `${ADMIN_CALLBACK.KB_LIST_PREFIX}1` }]] });
  }

  const preview = String(doc.content || "").slice(0, 900);
  const more = String(doc.content || "").length > 900 ? "\n…（预览已截断）" : "";

  let text = `📄 <b>${escapeHtml(doc.title)}</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `📎 来源：${escapeHtml(doc.source) || "手动录入"}\n`;
  text += `🧩 分块：${Number(doc.chunk_count) || 0}\n`;
  text += `🔘 状态：${Number(doc.enabled) === 1 ? "✅ 参与检索" : "🚫 已停用"}\n`;
  text += `🧩 作用域：<code>${escapeHtml(doc.scope_key)}</code>\n`;
  text += `🕒 更新：${escapeHtml(doc.updated_at || doc.created_at || "")}\n\n`;
  text += `📝 <b>正文预览：</b>\n${escapeHtml(preview)}${more}`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: Number(doc.enabled) === 1 ? "🚫 停用" : "✅ 启用",
          callback_data: `${ADMIN_CALLBACK.KB_TOGGLE_PREFIX}${doc.id}`
        },
        { text: "🗑️ 删除", callback_data: `${ADMIN_CALLBACK.KB_DEL_PREFIX}${doc.id}` }
      ],
      [{ text: "🔙 返回文档列表", callback_data: `${ADMIN_CALLBACK.KB_LIST_PREFIX}1` }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ==========================================
// 引导式添加文档
// ==========================================

/** 开始添加文档：先要标题 */
export async function startAddDocument({ env, token, chatId, uctx }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const scope = resolveKbScope(uctx);
  await setSession(env, chatId, "add:title", { scope: scope.scopeKey });

  const text =
    `➕ <b>添加知识库文档 · 第 1 步</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `作用域：<b>${scope.label}</b>\n\n` +
    `请输入<b>文档标题</b>（例如「群规 v2」「产品定价表」）：\n\n` +
    `（回复 <code>/cancel</code> 放弃）`;

  return sendMessage(token, chatId, text, "HTML");
}

/** 开始检索测试：让管理员输入一个问题 */
export async function startKnowledgeTest({ env, token, chatId, uctx }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const scope = resolveKbScope(uctx);
  await setSession(env, chatId, "test:query", { scope: scope.scopeKey });

  const text =
    `🔍 <b>知识库检索测试</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `作用域：<b>${scope.label}</b>\n\n` +
    `请发送一个用户可能会问的问题，我会返回命中的资料与相似度评分（用于判断资料是否够用）：\n\n` +
    `（回复 <code>/cancel</code> 放弃）`;

  return sendMessage(token, chatId, text, "HTML");
}

/**
 * 处理知识库引导流程里的文本输入。
 * @returns {Promise<boolean>} 是否已消费这条消息
 */
export async function handleKnowledgeInput({ env, token, chatId, uctx, userText, adminId = null }) {
  if (!env.DB) return false;

  const session = await getSession(env, chatId);
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  const step = String(session.step || "");
  const draft = parseDraft(session.draft);
  const scopeKey = draft.scope || resolveKbScope(uctx).scopeKey;

  // ---- 第 2 步：正文 ----
  if (step === "add:title") {
    draft.title = text.slice(0, 80);
    draft.scope = scopeKey;
    await setSession(env, chatId, "add:content", draft);
    await sendMessage(
      token, chatId,
      `✅ 标题已记录：<b>${escapeHtml(draft.title)}</b>\n\n` +
      `请把<b>正文</b>整段发过来（也可以直接发一个 <code>.txt</code> / <code>.md</code> 文件）：\n\n` +
      `（回复 <code>/cancel</code> 放弃）`,
      "HTML"
    );
    return true;
  }

  if (step === "add:content") {
    const title = String(draft.title || "").slice(0, 80);
    const res = await ingestDocument(env, {
      scopeKey, title, content: text, source: "手动录入", createdBy: adminId
    });
    await clearSession(env, chatId);

    if (!res.ok) {
      await sendMessage(token, chatId, `❌ 添加失败：${res.error}`);
      return true;
    }

    await logAdminAction(env, {
      adminId, chatId, action: "kb_doc_add",
      detail: `#${res.id} ${title}（${res.chunks} 块，作用域 ${scopeKey}）`
    });
    await sendMessage(
      token, chatId,
      `🎉 <b>文档已入库</b>\n${LAYOUT.DIVIDER}\n` +
      `📄 ${escapeHtml(title)}\n` +
      `🧩 切块：<b>${res.chunks}</b> 块${res.embedded ? "（已生成向量）" : "（未生成向量，仅关键词检索）"}\n\n` +
      `用户提问时就会检索到这份资料了。`,
      "HTML"
    );
    await renderKnowledgeHome(token, env, chatId, null, uctx);
    return true;
  }

  // ---- 检索测试 ----
  if (step === "test:query") {
    await clearSession(env, chatId);
    const hits = await searchKnowledge(env, scopeKey, text, { topK: 5, minScore: 0 });

    let body = `🔍 <b>检索测试</b>\n${LAYOUT.DIVIDER}\n`;
    body += `❓ 问题：${escapeHtml(text)}\n`;
    body += `🧩 作用域：<code>${escapeHtml(scopeKey)}</code>\n\n`;

    if (hits.length === 0) {
      body += `<i>没有命中任何资料。请确认文档已启用、内容与问题相关。</i>`;
    } else {
      hits.forEach((hit, index) => {
        body += `<b>${index + 1}. ${escapeHtml(hit.title)}</b> · 相似度 ${hit.score.toFixed(3)}\n`;
        body += `${escapeHtml(hit.content.slice(0, 200))}${hit.content.length > 200 ? "…" : ""}\n\n`;
      });
      body += `<i>相似度仅供判断资料是否匹配；越低说明越需要补充资料。</i>`;
    }

    await sendMessage(token, chatId, body, "HTML");
    return true;
  }

  // 未知步骤：清掉，交回正常流程
  await clearSession(env, chatId);
  return false;
}

// ==========================================
// 文档启停 / 删除
// ==========================================

/** 启用 / 停用文档 */
export async function handleDocumentToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const docId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.KB_TOGGLE_PREFIX, ""), 10);
  if (!env.DB || !Number.isInteger(docId)) return;

  const doc = await getDocument(env, docId);
  if (!doc) {
    await answerCallback(token, callback.id, "❌ 文档不存在", true);
    return;
  }

  const next = Number(doc.enabled) !== 1;
  await setDocumentEnabled(env, docId, next);
  await logAdminAction(env, {
    adminId, chatId, action: next ? "kb_doc_enable" : "kb_doc_disable", detail: `#${docId} ${doc.title}`
  });

  await answerCallback(token, callback.id, next ? "✅ 已启用" : "🚫 已停用");
  await renderDocumentDetail(token, env, chatId, msgId, docId);
}

/** 删除前二次确认 */
export async function handleDocumentDelete({ env, token, callback, chatId, msgId, data }) {
  const docId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.KB_DEL_PREFIX, ""), 10);
  if (!env.DB || !Number.isInteger(docId)) return;

  const doc = await getDocument(env, docId);
  if (!doc) {
    await answerCallback(token, callback.id, "❌ 文档不存在", true);
    return;
  }

  await answerCallback(token, callback.id, "请确认删除", false);
  await editMessageText(
    token, chatId, msgId,
    `🗑️ <b>确认删除文档？</b>\n${LAYOUT.DIVIDER}\n` +
    `📄 <b>${escapeHtml(doc.title)}</b>（${Number(doc.chunk_count) || 0} 块）\n\n` +
    `删除后 AI 立刻检索不到这份资料，且<b>无法恢复</b>。`,
    {
      inline_keyboard: [
        [{ text: "🗑️ 确认删除", callback_data: `${ADMIN_CALLBACK.KB_DELOK_PREFIX}${doc.id}` }],
        [{ text: "🔙 再想想", callback_data: `${ADMIN_CALLBACK.KB_DOC_PREFIX}${doc.id}` }]
      ]
    },
    "HTML"
  );
}

/** 确认删除 */
export async function handleDocumentDeleteConfirm({ env, token, callback, chatId, msgId, data, uctx, adminId = null }) {
  const docId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.KB_DELOK_PREFIX, ""), 10);
  if (!env.DB || !Number.isInteger(docId)) return;

  const doc = await getDocument(env, docId);
  await deleteDocument(env, docId);
  await logAdminAction(env, {
    adminId, chatId, action: "kb_doc_delete", detail: `#${docId} ${doc?.title || ""}`
  });

  await answerCallback(token, callback.id, "🗑️ 已删除");
  // 用当前会话的作用域回到列表（在群里打开就回到本群知识库）
  await renderDocumentList(token, env, chatId, msgId, uctx || { chatType: "private", chatId }, 1);
}

// ==========================================
// 文件上传（.txt / .md）
// ==========================================

/** 是否是允许入库的文本文件 */
export function isSupportedKnowledgeFile(document) {
  const name = String(document?.file_name || "").toLowerCase();
  const mime = String(document?.mime_type || "");
  if (mime.startsWith("text/")) return true;
  return ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 去掉扩展名后的文件名，作为默认标题 */
function fileTitle(document) {
  const name = String(document?.file_name || "上传文档");
  return name.replace(/\.[^.]+$/, "").slice(0, 80) || "上传文档";
}

/**
 * 处理管理员上传的知识库文件：下载 → 入库。
 * @returns {Promise<boolean>} 是否处理了这条消息
 */
export async function ingestUploadedDocument({ env, token, chatId, uctx, document, adminId = null }) {
  if (!env?.DB || !document || !isSupportedKnowledgeFile(document)) return false;

  const size = Number(document.file_size) || 0;
  if (size > KB.MAX_FILE_BYTES) {
    await sendMessage(
      token, chatId,
      `❌ 文件太大（${Math.round(size / 1024)} KB，上限 ${Math.round(KB.MAX_FILE_BYTES / 1024)} KB）。\n` +
      `请拆分后上传，或改用「📚 知识库 → ➕ 添加文档」直接粘贴文本。`
    );
    return true;
  }

  const scope = resolveKbScope(uctx);
  try {
    const file = await getFile(token, document.file_id);
    const content = file ? await downloadFileText(token, file.file_path, KB.MAX_FILE_BYTES) : null;

    if (!content || !content.trim()) {
      await sendMessage(token, chatId, "❌ 读取文件失败（可能不是纯文本，或文件过大）。");
      return true;
    }

    const title = fileTitle(document);
    const res = await ingestDocument(env, {
      scopeKey: scope.scopeKey,
      title,
      content,
      source: String(document.file_name || "上传文件").slice(0, 80),
      createdBy: adminId
    });

    if (!res.ok) {
      await sendMessage(token, chatId, `❌ 入库失败：${res.error}`);
      return true;
    }

    await logAdminAction(env, {
      adminId, chatId, action: "kb_doc_add",
      detail: `#${res.id} ${title}（文件上传，${res.chunks} 块，作用域 ${scope.scopeKey}）`
    });

    await sendMessage(
      token, chatId,
      `🎉 <b>文件已入库</b>\n${LAYOUT.DIVIDER}\n` +
      `📄 ${escapeHtml(title)}\n` +
      `🧩 切块：<b>${res.chunks}</b> 块${res.embedded ? "（已生成向量）" : "（未生成向量，仅关键词检索）"}\n` +
      `📚 作用域：${scope.label}`,
      "HTML"
    );
    return true;
  } catch (e) {
    logError("知识库文件入库失败：", e);
    await sendMessage(token, chatId, "❌ 入库失败，请稍后重试。");
    return true;
  }
}
