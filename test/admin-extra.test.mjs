// ==========================================
// 🧰 管理端增强测试
//
// 覆盖：用户详情聚合页、操作日志筛选、知识库索引重建、
//       文档生效范围（提升为全局 / 复制到本群）、.docx / .pdf 正文抽取。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { extractTextFromFile, docxXmlToText, pdfContentToText, detectFileKind } from "../src/services/text-extract.js";

// ---- Telegram API 桩 ----
let apiCalls = [];
let fileBuffer = null;

globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  const method = target.split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body, url: target });
  const ok = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result })
  });

  if (target.includes("/file/bot")) {
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => fileBuffer };
  }
  if (method === "getFile") return ok({ file_path: "docs/upload.bin", file_size: fileBuffer ? fileBuffer.byteLength : 0 });
  if (method === "getMe") return ok({ id: 42, username: "TestBot", is_bot: true });
  if (method === "getChatMember") return ok({ status: "administrator", can_restrict_members: true, user: { id: 42 } });
  return ok({ message_id: 99 });
};

const resetCalls = () => { apiCalls.length = 0; };
const sentTexts = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
/** 直接数 kb_chunks（避免用需要 scope 的服务函数） */
const chunkCount = (db, docId = null) => Number(
  docId
    ? db.get("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?", docId).n
    : db.get("SELECT COUNT(*) AS n FROM kb_chunks").n
) || 0;

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: {
    run: async (_m, o = {}) => {
      if (Array.isArray(o.text)) return { data: o.text.map((t) => [String(t).length % 7, 1, 0]) };
      return { response: "ok" };
    }
  },
  BOT_TOKEN: "TEST_TOKEN",
  BOT_USERNAME: "TestBot",
  MY_TELEGRAM_ID: "999",
  APP_TIMEZONE: "Asia/Shanghai",
  ...extra
});

const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

const adminUctx = {
  chatId: "1", userId: "999", chatType: "private",
  userKey: "user:999", sceneKey: "private:999",
  username: "admin", firstName: "管理员"
};

const groupAdminUctx = { ...adminUctx, chatId: "-100", chatType: "supergroup", sceneKey: "group:-100:user:999" };

const { handleCallback } = await import("../src/handlers/callback.js");
const { handleMessage } = await import("../src/handlers/message.js");
const { renderAdminLogs } = await import("../src/admin/logs.js");
const { renderUserDetail } = await import("../src/admin/user-detail.js");
const { ingestDocument, listDocuments, countChunks, searchKnowledge, reindexKnowledge, KB_GLOBAL_SCOPE } =
  await import("../src/services/knowledge.js");

// ==========================================
// 1. 用户详情聚合页
// ==========================================

test("用户详情：一屏聚合积分 / 签到 / 任务 / 订单 / 处置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 250);
  const itemId = seedItem(db, { name: "测试商品", price: 10, stock: 5 });
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name, lang)
           VALUES ('private:555', 'user:555', '555', 'private', '555', 'tester', '测试用户', 'zh')`);
  const rowId = Number(db.get("SELECT id FROM user_scenes ORDER BY id DESC LIMIT 1").id);

  db.exec(`INSERT INTO points_log (user_key, change_amount, balance_after, reason)
           VALUES ('user:555', -1, 249, 'AI 对话消耗')`);
  db.exec(`INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status)
           VALUES ('S123', 'user:555', '555', '555', ${itemId}, '测试商品', '🎁', 10, 'pending')`);
  db.exec(`INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:555', '2026-09-11')`);
  db.exec(`INSERT INTO group_punishments (chat_id, user_id, user_label, action, reason, status, operator_id)
           VALUES ('-100', '555', '测试用户', 'mute', '刷屏', 'done', '999')`);

  const env = makeEnv(db);
  resetCalls();
  await renderUserDetail("TEST_TOKEN", env, "1", 70, rowId);

  const text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("用户详情"));
  assert.ok(text.includes("测试用户"));
  assert.ok(text.includes("250"), "应显示积分");
  assert.ok(text.includes("累计 1 天"), "应显示签到");
  assert.ok(text.includes("S123"), "应显示订单");
  assert.ok(text.includes("群内禁言"), "应显示处置记录");
  assert.ok(text.includes("AI 对话消耗"), "应显示积分流水");

  const keys = apiCalls.filter((c) => c.method === "editMessageText").at(-1)
    .body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes(`admin_manage_user_${rowId}`), "能返回场景编辑");
  db.close();
});

test("场景编辑菜单里能进用户详情", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:555", 10);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
           VALUES ('private:555', 'user:555', '555', 'private', '555', '测试用户')`);
  const rowId = Number(db.get("SELECT id FROM user_scenes ORDER BY id DESC LIMIT 1").id);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data: `admin_detail_${rowId}`,
        message: { message_id: 71, chat: { id: 1, type: "private" } }
      }
    }
  });

  const text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("用户详情"));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 2. 操作日志筛选
// ==========================================

test("操作日志：按类别筛选只返回该类别记录", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  db.exec(`INSERT INTO admin_logs (admin_id, action, detail) VALUES ('999', 'user_block', '封了一个人')`);
  db.exec(`INSERT INTO admin_logs (admin_id, action, detail) VALUES ('999', 'shop_item_add', '加了商品')`);
  db.exec(`INSERT INTO admin_logs (admin_id, action, detail) VALUES ('999', 'guard_execute', '执行了禁言')`);
  db.exec(`INSERT INTO admin_logs (admin_id, action, detail) VALUES ('999', 'kb_doc_add', '加了文档')`);
  const env = makeEnv(db);
  resetCalls();

  await renderAdminLogs("TEST_TOKEN", env, "1", 80, 1, "guard");
  let text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("执行了禁言"));
  assert.ok(!text.includes("封了一个人"));
  assert.ok(!text.includes("加了商品"));
  assert.ok(text.includes("🛡️ 执法"), "应显示当前筛选");

  resetCalls();
  await renderAdminLogs("TEST_TOKEN", env, "1", 80, 1, "shop");
  text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("加了商品"));
  assert.ok(!text.includes("执行了禁言"));

  // 系统类 = 不属于任何已知分类
  db.exec(`INSERT INTO admin_logs (admin_id, action, detail) VALUES ('999', 'redeem_code_create', '发了码')`);
  resetCalls();
  await renderAdminLogs("TEST_TOKEN", env, "1", 80, 1, "system");
  text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("发了码"));
  assert.ok(!text.includes("执行了禁言"));

  // 未知筛选键回退成全部
  resetCalls();
  await renderAdminLogs("TEST_TOKEN", env, "1", 80, 1, "不存在的筛选");
  text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("全部"));
  assert.ok(text.includes("执行了禁言") && text.includes("加了商品"));

  // 筛选按钮齐全
  const keys = apiCalls.filter((c) => c.method === "editMessageText").at(-1)
    .body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const f of ["all", "user", "shop", "guard", "kb", "task", "system"]) {
    assert.ok(keys.includes(`admin_logs_f_${f}_1`), `缺少筛选项 ${f}`);
  }
  db.close();
});

// ==========================================
// 3. 知识库：重建索引 + 生效范围
// ==========================================

test("重建索引：把没有向量的分块补上（模拟上传时未绑定 AI）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  // 先在没有 AI 的环境里入库 → 不会写向量
  await ingestDocument(makeEnv(db, { AI: undefined }), {
    scopeKey: KB_GLOBAL_SCOPE, title: "无向量文档", content: "退货规则：7 天内可无理由退货。"
  });
  assert.ok(chunkCount(db) > 0);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM kb_chunks WHERE embedding = ''").n), chunkCount(db));

  const result = await reindexKnowledge(env, { limit: 20 });
  assert.equal(result.ok, true);
  assert.ok(result.updated > 0, "应重建若干分块");
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM kb_chunks WHERE embedding = ''").n), 0, "不应再有无向量分块");
  assert.equal(result.remaining, 0);

  // 有向量后就能语义检索到
  const hits = await searchKnowledge(env, KB_GLOBAL_SCOPE, "退货规则");
  assert.equal(hits.length >= 1, true);
  db.close();
});

test("文档生效范围：群文档可提升为全局，全局文档可复制到本群", { skip: !hasSqlite && "需要 sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  const groupDoc = await ingestDocument(env, {
    scopeKey: "group:-100", title: "本群手册", content: "本群专属：禁止广告。"
  });
  const globalDoc = await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE, title: "全局政策", content: "全局：退货 7 天。"
  });

  // 群 → 全局
  const { moveDocumentScope, copyDocumentToScope } = await import("../src/services/knowledge.js");
  const promoted = await moveDocumentScope(env, groupDoc.id, "global");
  assert.equal(promoted.ok, true);
  assert.equal(db.get("SELECT scope_key FROM kb_docs WHERE id = ?", groupDoc.id).scope_key, "global");
  assert.equal(
    Number(db.get("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ? AND scope_key = 'global'", groupDoc.id).n),
    chunkCount(db, groupDoc.id)
  );
  // 提升为全局后，别的群也能检索到
  assert.equal((await searchKnowledge(env, "group:-200", "本群专属 禁止广告")).length >= 1, true);

  // 全局 → 复制到本群
  const copied = await copyDocumentToScope(env, globalDoc.id, "group:-100", "999");
  assert.equal(copied.ok, true);
  const copyRow = db.get("SELECT * FROM kb_docs WHERE id = ?", copied.id);
  assert.equal(copyRow.scope_key, "group:-100");
  assert.equal(copyRow.title, "全局政策");
  assert.equal(chunkCount(db, copied.id), chunkCount(db, globalDoc.id), "分块应一起复制");
  db.close();
});

test("知识库面板：文档详情能切范围，首页能重建索引", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const doc = await ingestDocument(env, { scopeKey: "group:-100", title: "本群文档", content: "禁止广告。" });

  // 首页有重建索引按钮
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: groupAdminUctx,
    payload: {
      callback_query: {
        id: "cb1", from: { id: 999 }, data: "admin_kb",
        message: { message_id: 90, chat: { id: -100, type: "supergroup" } }
      }
    }
  });
  let keys = apiCalls.filter((c) => c.method === "editMessageText").at(-1)
    .body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes("admin_kb_reindex"));

  // 群文档详情里有「设为全局」
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: groupAdminUctx,
    payload: {
      callback_query: {
        id: "cb2", from: { id: 999 }, data: `admin_kb_doc_${doc.id}`,
        message: { message_id: 91, chat: { id: -100, type: "supergroup" } }
      }
    }
  });
  keys = apiCalls.filter((c) => c.method === "editMessageText").at(-1)
    .body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes(`admin_kb_promote_${doc.id}`));

  // 点一下真的变成全局
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: groupAdminUctx,
    payload: {
      callback_query: {
        id: "cb3", from: { id: 999 }, data: `admin_kb_promote_${doc.id}`,
        message: { message_id: 91, chat: { id: -100, type: "supergroup" } }
      }
    }
  });
  assert.equal(db.get("SELECT scope_key FROM kb_docs WHERE id = ?", doc.id).scope_key, "global");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 4. 文档解析（纯文本 / docx / pdf）
// ==========================================

/** 造一个「存储式」zip（不压缩），用于测试 docx 解析 */
function buildStoredZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const chunk of all) { out.set(chunk, pos); pos += chunk.length; }
  return out.buffer;
}

test("detectFileKind：按扩展名/类型判断解析方式", () => {
  assert.equal(detectFileKind("a.txt", ""), "text");
  assert.equal(detectFileKind("说明.docx", ""), "docx");
  assert.equal(detectFileKind("手册.PDF", ""), "pdf");
  assert.equal(detectFileKind("x", "text/plain"), "text");
  assert.equal(detectFileKind("资料.zip", "application/zip"), "unknown");
});

test("docx：解出 zip 里的 document.xml 并还原段落", async () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>第一条 禁止广告</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二条 禁止刷屏</w:t></w:r></w:p>
  </w:body></w:document>`;
  const buffer = buildStoredZip([["word/document.xml", xml]]);

  const res = await extractTextFromFile({ buffer, fileName: "群规.docx" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.kind, "docx");
  assert.match(res.text, /第一条 禁止广告/);
  assert.match(res.text, /第二条 禁止刷屏/);

  // 纯函数：标签剥离与实体还原
  assert.equal(docxXmlToText("<w:p><w:t>a&amp;b</w:t></w:p>").trim(), "a&b");
});

test("pdf：尽力抽取文本层，抽不出来时给出明确提示", async () => {
  const body = "BT /F1 12 Tf (退货规则：7 天内可无理由退货，联系管理员处理，禁止广告刷屏) Tj ET";
  const pdf = new TextEncoder().encode(`%PDF-1.4\n2 0 obj<</Length 80>>stream\n${body}\nendstream endobj\ntrailer<<>>\n%%EOF`);
  const res = await extractTextFromFile({ buffer: pdf.buffer, fileName: "手册.pdf" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.kind, "pdf");
  assert.match(res.text, /退货规则/);
  assert.ok(pdfContentToText(`${body}\n`).includes("退货规则"));

  // 没有文字层（空流）→ 明确提示而不是静默失败
  const empty = new TextEncoder().encode("%PDF-1.4\n3 0 obj<</Length 4>>stream\n    \nendstream endobj\n%%EOF");
  const emptyRes = await extractTextFromFile({ buffer: empty.buffer, fileName: "扫描件.pdf" });
  assert.equal(emptyRes.ok, false);
  assert.match(emptyRes.error, /没有可提取的文字层/);
});

test("上传 .docx 入库：管理员发文件即可，正文自动解析", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const xml = `<w:document><w:body><w:p><w:r><w:t>退货规则：7 天内可无理由退货</w:t></w:r></w:p></w:body></w:document>`;
  fileBuffer = buildStoredZip([["word/document.xml", xml]]);

  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: groupAdminUctx, isGroupCtx: true,
    payload: {
      message: {
        text: "@TestBot", entities: [{ type: "mention", offset: 0, length: 9 }],
        document: { file_id: "d1", file_name: "售后手册.docx", file_size: 2048, mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      }
    }
  });

  const doc = db.get("SELECT * FROM kb_docs ORDER BY id DESC LIMIT 1");
  assert.ok(doc, "应写入文档");
  assert.equal(doc.title, "售后手册");
  assert.equal(doc.scope_key, "group:-100", "群里上传进本群知识库");
  assert.match(doc.content, /退货规则/);
  assert.match(doc.source, /docx/);
  assert.ok(sentTexts().some((t) => t.includes("文件已入库")));
  await Promise.all(ctx.pending);
  db.close();
});

test("上传不支持的格式（.zip）会提示", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  fileBuffer = new Uint8Array([1, 2, 3]).buffer;
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx, isGroupCtx: false,
    payload: {
      message: { document: { file_id: "d2", file_name: "资料.zip", file_size: 3, mime_type: "application/zip" } }
    }
  });

  assert.equal(db.count("kb_docs"), 0);
  assert.ok(sentTexts().some((t) => t.includes("只支持")));
  await Promise.all(ctx.pending);
  db.close();
});
