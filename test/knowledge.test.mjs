// ==========================================
// 📚 知识库（RAG）测试
//
// 覆盖：分块、向量编解码、余弦相似度、关键词兜底、入库/检索/停用/删除、
//       容量保护、管理员文件上传，以及「AI 回答前注入检索结果」的完整链路。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { KB } from "../src/config/constants.js";
import {
  chunkText, encodeEmbedding, decodeEmbedding, cosineSimilarity, bigramScore,
  ingestDocument, searchKnowledge, buildKnowledgeContext, listDocuments,
  setDocumentEnabled, deleteDocument, countChunks, KB_GLOBAL_SCOPE,
  buildKnowledgeInstruction, resolveAnswerMode
} from "../src/services/knowledge.js";

// ---- 假的 Workers AI：把文本映射成「关键词命中」的 4 维向量 ----
const MARKERS = ["退货", "运费", "价格", "颜色"];
const fakeVector = (text) => {
  const s = String(text ?? "");
  return MARKERS.map((m) => (s.includes(m) ? 1 : 0));
};

const aiCalls = [];
const fakeAI = {
  async run(_model, opts = {}) {
    if (Array.isArray(opts.text)) return { data: opts.text.map(fakeVector) };
    aiCalls.push(opts);
    return { response: "根据资料：7 天无理由退货。" };
  }
};

// ---- Telegram API 桩 ----
const apiCalls = [];
const FILE_TEXT = "本群禁止广告。\n\n退货规则：7 天内可无理由退货。";
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  const method = target.split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body, url: target, httpMethod: opts.method || "GET" });

  // 文件下载：模拟 Telegram /file/bot<token>/<path>
  if (target.includes("/file/bot")) {
    const buffer = new TextEncoder().encode(FILE_TEXT).buffer;
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buffer };
  }
  if (method === "getFile") {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ ok: true, result: { file_path: "docs/rule.txt", file_size: FILE_TEXT.length } })
    };
  }
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 99 } })
  };
};

const sentTexts = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
const resetCalls = () => { apiCalls.length = 0; aiCalls.length = 0; };

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: fakeAI,
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

const { handleMessage } = await import("../src/handlers/message.js");

// ==========================================
// 文本处理
// ==========================================

test("chunkText：按段落成块，超长段落带重叠硬切", () => {
  // 短段落会合并到一块
  assert.deepEqual(chunkText("第一段\n\n第二段"), ["第一段\n\n第二段"]);

  // 段落超过 maxChars 时硬切，并且相邻块有重叠
  const long = "甲".repeat(25);
  const chunks = chunkText(long, { maxChars: 10, overlap: 4 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 10));
  // 重叠意味着前一块的尾部出现在后一块的开头
  assert.equal(chunks[0].slice(6), chunks[1].slice(0, 4));

  assert.deepEqual(chunkText("   \n\n  "), []);
});

test("chunkText：脏输入不会抛异常，且受 MAX_CHUNKS_PER_DOC 限制", () => {
  assert.deepEqual(chunkText(null), []);
  // 5 万字按 90 字步长切会得到 500+ 块，必须被上限截断
  assert.equal(chunkText("x".repeat(50000), { maxChars: 100, overlap: 10 }).length, KB.MAX_CHUNKS_PER_DOC);
});

// ==========================================
// 向量工具
// ==========================================

test("向量 base64 编解码往返一致，余弦相似度符合直觉", () => {
  const vec = [0.5, -0.25, 1, 0];
  const decoded = decodeEmbedding(encodeEmbedding(vec));
  assert.equal(decoded.length, vec.length);
  decoded.forEach((v, i) => assert.ok(Math.abs(v - vec[i]) < 1e-6));

  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosineSimilarity([], [1, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(decodeEmbedding("不是 base64").length, 0);
});

test("bigramScore：中文按二元字组匹配", () => {
  assert.equal(bigramScore("退货", "支持 7 天无理由退货"), 1);
  assert.equal(bigramScore("退货", "本群禁止广告"), 0);
  // 中文按二元组算重合率：4 个二元组里命中「退货」→ 0.25（已高于关键词兜底阈值）
  assert.ok(bigramScore("怎么退货呢", "退货规则：7 天内可无理由退货") >= 0.25);
  assert.equal(bigramScore("a", "abc"), 0, "单字不参与匹配");
});

// ==========================================
// 入库与检索
// ==========================================

test("ingestDocument：切块入库并生成向量", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  const res = await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE,
    title: "售后政策",
    content: "退货规则：7 天内可无理由退货。\n\n运费规则：质量问题由本店承担运费。",
    source: "手动录入"
  });

  assert.equal(res.ok, true);
  assert.ok(res.chunks >= 1);
  assert.equal(res.embedded, true, "绑定 AI 时应写入向量");

  const doc = db.get("SELECT * FROM kb_docs WHERE id = ?", res.id);
  assert.equal(doc.title, "售后政策");
  assert.equal(doc.chunk_count, res.chunks);
  assert.equal(countChunksSync(db), res.chunks);
  db.close();
});

/** 直接数一下 kb_chunks（测试辅助） */
function countChunksSync(db) {
  return Number(db.get("SELECT COUNT(*) AS n FROM kb_chunks").n) || 0;
}

test("searchKnowledge：语义命中排在最前，无关问题不返回", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE, title: "退货政策", content: "退货：7 天无理由退货。"
  });
  await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE, title: "价格表", content: "价格：基础版 99 元。"
  });

  const hits = await searchKnowledge(env, KB_GLOBAL_SCOPE, "我要退货，怎么退？");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].title, "退货政策");
  assert.ok(hits[0].score > KB.MIN_SCORE);

  const none = await searchKnowledge(env, KB_GLOBAL_SCOPE, "今天天气怎么样");
  assert.deepEqual(none, [], "无关问题不应命中（fake 向量全 0，余弦为 0）");
  db.close();
});

test("searchKnowledge：没有 Workers AI 时退化为关键词检索", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db, { AI: undefined });
  const res = await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE, title: "群规", content: "本群禁止发广告，违者移出群聊。"
  });
  assert.equal(res.embedded, false, "没有 AI 时不应写入向量");

  const hits = await searchKnowledge(env, KB_GLOBAL_SCOPE, "群里能发广告吗");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].title, "群规");
  db.close();
});

test("检索门槛：语义勉强过线但没有关键词重叠的资料会被丢弃", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  // 含「退货」的文本给 [1,0]；其它文本给一个与查询余弦≈0.35 的向量
  // （0.35 高于最低阈值 0.30，但低于「强相关」0.45）
  const env = makeEnv(db, {
    AI: {
      async run(_m, opts = {}) {
        if (Array.isArray(opts.text)) {
          return { data: opts.text.map((t) => (String(t).includes("退货") ? [1, 0] : [0.35, 0.93675])) };
        }
        return { response: "ok" };
      }
    }
  });

  await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "运费说明", content: "运费由买家承担，偏远地区另计。" });
  await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "退货政策", content: "退货：7 天无理由退货。" });

  const hits = await searchKnowledge(env, KB_GLOBAL_SCOPE, "退货政策是什么");
  assert.equal(hits.length, 1, "只应保留真正相关的资料（无关资料不该被注入提示词）");
  assert.equal(hits[0].title, "退货政策");
  assert.ok(hits[0].keyword > 0, "结果里应保留关键词分数");
  db.close();
});

test("回答模式：hybrid 允许用 AI 自己的知识回答，strict 只依据资料", () => {
  assert.equal(resolveAnswerMode({}), "hybrid");
  assert.equal(resolveAnswerMode({ KB_ANSWER_MODE: "strict" }), "strict");
  assert.equal(resolveAnswerMode({ KB_ANSWER_MODE: "STRICT" }), "strict");
  assert.equal(resolveAnswerMode({ KB_ANSWER_MODE: "其它值" }), "hybrid");

  const context = "【资料：退货政策】\n7 天无理由退货";
  const hybrid = buildKnowledgeInstruction(context);
  assert.ok(hybrid.includes("【知识库资料】"));
  assert.ok(hybrid.includes("不要因为「资料里没写」就拒绝回答"), "hybrid 要允许用自己的知识回答");
  assert.ok(hybrid.includes("不要编造"), "hybrid 也要禁止编造来源");

  const strict = buildKnowledgeInstruction(context, "strict");
  assert.ok(strict.includes("只依据上面的资料回答"));
  assert.ok(strict.includes("如实说明「资料中未提及」"));
  assert.ok(!strict.includes("不要因为「资料里没写」就拒绝回答"));
});

test("searchKnowledge：本群资料与全局资料一起参与，停用后立刻失效", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const sceneKey = "group:-100";

  await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "全局政策", content: "退货：7 天无理由退货。" });
  const local = await ingestDocument(env, { scopeKey: sceneKey, title: "本群规定", content: "退货：本群统一由管理员代收。" });

  const hits = await searchKnowledge(env, sceneKey, "退货怎么处理");
  assert.equal(hits.length >= 1, true);

  await setDocumentEnabled(env, local.id, false);
  const after = await searchKnowledge(env, sceneKey, "退货怎么处理");
  assert.ok(!after.some((h) => h.docId === local.id), "停用的文档不应出现在结果里");

  // 别的群检索不到本群资料
  const other = await searchKnowledge(env, "group:-200", "本群统一由管理员代收");
  assert.ok(!other.some((h) => h.docId === local.id));
  db.close();
});

test("deleteDocument：文档与分块一起清空", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const res = await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "临时", content: "价格：99 元。" });

  assert.ok(countChunksSync(db) > 0);
  await deleteDocument(env, res.id);
  assert.equal(countChunksSync(db), 0);
  assert.equal(db.count("kb_docs"), 0);
  db.close();
});

test("容量保护：超过 MAX_TOTAL_CHUNKS 时拒绝入库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const original = KB.MAX_TOTAL_CHUNKS;
  KB.MAX_TOTAL_CHUNKS = 1;

  try {
    const first = await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "第一", content: "价格：99 元。" });
    assert.equal(first.ok, true);

    const second = await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "第二", content: "退货：7 天。" });
    assert.equal(second.ok, false);
    assert.match(second.error, /容量已满/);
  } finally {
    KB.MAX_TOTAL_CHUNKS = original;
  }
  db.close();
});

test("buildKnowledgeContext：拼装资料并截断超长内容", () => {
  assert.equal(buildKnowledgeContext([]), "");
  const text = buildKnowledgeContext([
    { title: "群规", content: "禁止广告", score: 0.9 },
    { title: "价格", content: "99 元", score: 0.5 }
  ]);
  assert.ok(text.includes("【资料：群规】") && text.includes("【资料：价格】"));

  const long = buildKnowledgeContext([{ title: "长文", content: "字".repeat(5000), score: 1 }], 300);
  assert.ok(long.length <= 320, `应被截断，实际 ${long.length}`);
});

test("listDocuments：分页与统计", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  for (let i = 1; i <= 7; i++) {
    await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: `文档${i}`, content: `价格：${i} 元。` });
  }

  const page1 = await listDocuments(env, KB_GLOBAL_SCOPE, 1, 6);
  assert.equal(page1.total, 7);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.rows.length, 6);

  const page9 = await listDocuments(env, KB_GLOBAL_SCOPE, 9, 6);
  assert.equal(page9.page, 2, "越界页码应收敛到最后一页");
  db.close();
});

// ==========================================
// 与 AI 对话的集成
// ==========================================

test("AI 对话：命中知识库时把资料拼进提示词", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await ingestDocument(env, {
    scopeKey: "group:-100", title: "退货政策", content: "退货：7 天内可无理由退货，联系管理员。"
  });

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "-100", userId: "999", chatType: "supergroup",
      userKey: "user:999", sceneKey: "group:-100:user:999",
      username: "admin", firstName: "管理员"
    },
    isGroupCtx: true,
    payload: {
      message: { text: "@TestBot 退货怎么办", entities: [{ type: "mention", offset: 0, length: 9 }] }
    }
  });

  assert.equal(aiCalls.length, 1, "应该调用了一次对话模型");
  const systemPrompt = aiCalls[0].messages[0].content;
  assert.ok(systemPrompt.includes("【知识库资料】"), "提示词应包含检索到的资料");
  assert.ok(systemPrompt.includes("退货政策"));
  assert.ok(systemPrompt.includes("不要因为「资料里没写」就拒绝回答"), "默认 hybrid：资料没覆盖也要用 AI 自己的知识回答");
  assert.ok(!systemPrompt.includes("只依据上面的资料回答"), "hybrid 不应该限制成只能依据资料");
  await Promise.all(ctx.pending);
  db.close();
});

test("AI 对话：strict 模式下才要求「只依据资料」", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db, { KB_ANSWER_MODE: "strict" });
  const ctx = makeCtx();
  resetCalls();

  await ingestDocument(env, {
    scopeKey: KB_GLOBAL_SCOPE, title: "退货政策", content: "退货：7 天内可无理由退货。"
  });

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:1",
      username: "admin", firstName: "管理员"
    },
    isGroupCtx: false,
    payload: { message: { text: "退货怎么办", entities: [] } }
  });

  assert.equal(aiCalls.length, 1);
  const systemPrompt = aiCalls[0].messages[0].content;
  assert.ok(systemPrompt.includes("只依据上面的资料回答"));
  assert.ok(systemPrompt.includes("如实说明「资料中未提及」"));
  await Promise.all(ctx.pending);
  db.close();
});

test("AI 对话：知识库没有相关资料时，提示词里完全不带资料段落", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  // 库里只有无关资料
  await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "群规", content: "本群禁止广告刷屏。" });

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:1"
    },
    isGroupCtx: false,
    payload: { message: { text: "帮我写一段 Python 快速排序", entities: [] } }
  });

  assert.equal(aiCalls.length, 1);
  const systemPrompt = aiCalls[0].messages[0].content;
  assert.ok(!systemPrompt.includes("【知识库资料】"), "没有命中时不应注入资料段落");
  assert.ok(!systemPrompt.includes("资料中未提及"));
  await Promise.all(ctx.pending);
  db.close();
});

test("AI 对话：知识库关闭开关后不再检索", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await ingestDocument(env, { scopeKey: KB_GLOBAL_SCOPE, title: "退货政策", content: "退货：7 天无理由退货。" });
  const { setFeature, GLOBAL_SCOPE } = await import("../src/services/features.js");
  await setFeature(env, GLOBAL_SCOPE, "kb", false);

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:1",
      username: "admin", firstName: "管理员"
    },
    isGroupCtx: false,
    payload: { message: { text: "退货怎么办", entities: [] } }
  });

  assert.equal(aiCalls.length, 1);
  assert.ok(!aiCalls[0].messages[0].content.includes("【知识库资料】"));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 管理员上传文件
// ==========================================

test("管理员发送 .txt 文件 → 直接入库（标题取文件名）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:999",
      username: "admin", firstName: "管理员"
    },
    isGroupCtx: false,
    payload: {
      message: {
        document: { file_id: "f1", file_name: "群规.txt", file_size: FILE_TEXT.length, mime_type: "text/plain" }
      }
    }
  });

  const doc = db.get("SELECT * FROM kb_docs ORDER BY id DESC LIMIT 1");
  assert.ok(doc, "应该写入了文档");
  assert.equal(doc.title, "群规");
  assert.match(doc.source, /群规\.txt/, "来源里应保留原文件名");
  assert.match(doc.source, /text/, "来源里应记录解析方式");
  assert.equal(doc.scope_key, KB_GLOBAL_SCOPE, "私聊上传进全局知识库");
  assert.ok(sentTexts().some((t) => t.includes("文件已入库")));

  // 上传的内容也能被检索到
  const hits = await searchKnowledge(env, KB_GLOBAL_SCOPE, "退货规则");
  assert.equal(hits[0].title, "群规");
  await Promise.all(ctx.pending);
  db.close();
});

test("管理员发送不支持的文件类型 → 给出提示且不入库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:999"
    },
    isGroupCtx: false,
    payload: {
      message: { document: { file_id: "f2", file_name: "资料.zip", file_size: 100, mime_type: "application/zip" } }
    }
  });

  assert.equal(db.count("kb_docs"), 0);
  assert.ok(sentTexts().some((t) => t.includes("只支持")));
  await Promise.all(ctx.pending);
  db.close();
});

test("群里管理知识库：管理员不 @ 机器人也能粘贴正文", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const uctx = {
    chatId: "-100", userId: "999", chatType: "supergroup",
    userKey: "user:999", sceneKey: "group:-100:user:999"
  };
  const send = (message) => handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx, isGroupCtx: true, payload: { message }
  });

  // 管理员的普通群消息（没有 @）默认应当被忽略
  await send({ text: "这句不该被处理", entities: [] });
  assert.ok(!sentTexts().some((t) => t.includes("标题已记录")), "无引导时不应响应");

  // 进入知识库「添加文档」引导后，同一场景的纯文本应该被当成输入
  await setKnowledgeSession(db, "-100", "add:title", { scope: "group:-100" });
  await send({ text: "群规", entities: [] });
  assert.ok(sentTexts().some((t) => t.includes("标题已记录")), "引导中应接收纯文本");

  await send({ text: "本群禁止广告。", entities: [] });
  const doc = db.get("SELECT * FROM kb_docs ORDER BY id DESC LIMIT 1");
  assert.ok(doc, "正文应写入本群知识库");
  assert.equal(doc.scope_key, "group:-100");

  await Promise.all(ctx.pending);
  db.close();
});

/** 直接写一条知识库引导会话（模拟点了「➕ 添加文档」） */
function setKnowledgeSession(db, chatId, step, draft) {
  db.exec(
    `INSERT INTO kb_sessions (chat_id, step, draft, updated_at)
     VALUES ('${chatId}', '${step}', '${JSON.stringify(draft)}', CURRENT_TIMESTAMP)`
  );
}
