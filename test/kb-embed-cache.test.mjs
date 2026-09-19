// ==========================================
// 🧠 知识库「问题向量」缓存（v3.8.0）
//
// 背景：RAG 检索在 AI 回答**之前**，每次都要把问题送去 bge-m3 向量化。
// 群里多人问同一句、或用户反复问同一个 FAQ 时，这份调用完全是重复的 ——
// 既烧模型额度，又给每条回答多加一次 AI 往返。
// 现在按「模型名 + 规范化问题」在 isolate 内缓存 5 分钟。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { searchKnowledge } from "../src/services/knowledge.js";
import { cacheClear } from "../src/services/cache.js";

const NS = "kb-query-vec";
const SCOPE = "global";

let embedCalls = 0;
const makeAI = () => ({
  run: async (_model, opts) => {
    embedCalls++;
    const texts = Array.isArray(opts?.text) ? opts.text : [opts?.text];
    return { data: texts.map(() => [0.1, 0.2, 0.3, 0.4]) };
  }
});
const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", APP_TIMEZONE: "Asia/Shanghai", AI: makeAI(), ...extra
});

/** 造一篇启用中的文档 + 一个分块（检索要至少有一个候选才会走向量化） */
function seedChunk(db, content = "签到每天可以领积分，连续签到奖励更高") {
  db.exec(
    `INSERT INTO kb_docs (scope_key, title, content, enabled, chunk_count)
     VALUES ('${SCOPE}', '使用说明', '${content}', 1, 1)`
  );
  const doc = db.get("SELECT id FROM kb_docs ORDER BY id DESC LIMIT 1");
  db.exec(
    `INSERT INTO kb_chunks (doc_id, scope_key, seq, content, dim, embedding, model)
     VALUES (${doc.id}, '${SCOPE}', 0, '${content}', 0, '', '')`
  );
}

function fresh() {
  cacheClear(NS);      // isolate 缓存是模块级的，用例之间必须清干净
  embedCalls = 0;
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  seedChunk(db);
  return db;
}

test("同一个问题问两次：只向量化一次（第二次走缓存）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  await searchKnowledge(env, SCOPE, "怎么签到", { topK: 3 });
  assert.equal(embedCalls, 1, "第一次要真的调模型");

  await searchKnowledge(env, SCOPE, "怎么签到", { topK: 3 });
  assert.equal(embedCalls, 1, "同一个问题第二次不该再调模型（这就是缓存的价值）");
  db.close();
});

test("空白差异不影响缓存命中（规范化后再比）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  await searchKnowledge(env, SCOPE, "怎么签到", { topK: 3 });
  await searchKnowledge(env, SCOPE, "  怎么签到  ", { topK: 3 });
  await searchKnowledge(env, SCOPE, "怎么   签到", { topK: 3 });

  assert.equal(embedCalls, 1, "折叠空白后是同一个问题");
  db.close();
});

test("不同问题各算各的（缓存不能串答案）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  await searchKnowledge(env, SCOPE, "怎么签到", { topK: 3 });
  await searchKnowledge(env, SCOPE, "怎么兑换码", { topK: 3 });
  await searchKnowledge(env, SCOPE, "积分怎么用", { topK: 3 });

  assert.equal(embedCalls, 3, "三个不同问题应该各调一次");
  db.close();
});

test("换向量模型后缓存自然失效（key 里带了模型名）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const envA = makeEnv(db);
  const envB = makeEnv(db, { KB_EMBED_MODEL: "@cf/baai/other-model" });

  await searchKnowledge(envA, SCOPE, "怎么签到", { topK: 3 });
  assert.equal(embedCalls, 1);

  await searchKnowledge(envB, SCOPE, "怎么签到", { topK: 3 });
  assert.equal(embedCalls, 2, "不同模型必须重新算（否则会拿另一个模型的向量去比）");
  db.close();
});

test("向量化失败时照常降级为关键词检索，且失败结果不进缓存", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  let calls = 0;
  const env = makeEnv(db, {
    AI: { run: async () => { calls++; throw new Error("model down"); } }
  });

  const first = await searchKnowledge(env, SCOPE, "签到", { topK: 3 });
  const second = await searchKnowledge(env, SCOPE, "签到", { topK: 3 });

  assert.ok(Array.isArray(first) && Array.isArray(second), "失败也要返回结果（降级为关键词）");
  assert.equal(calls, 2, "失败不缓存，下次还会重试（否则模型恢复后也一直降级）");
  db.close();
});

test("空问题与超短问题直接返回，不做向量化", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  assert.deepEqual(await searchKnowledge(env, SCOPE, "", { topK: 3 }), []);
  assert.deepEqual(await searchKnowledge(env, SCOPE, "签", { topK: 3 }), []);
  assert.equal(embedCalls, 0, "短于 2 字的问题不该浪费一次模型调用");
  db.close();
});
