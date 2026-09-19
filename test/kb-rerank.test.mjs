// ==========================================
// 🔀 知识库「候选补读分批」与「重排序」（v3.9.0）
//
// 1) 回归修复：v3.8.0 的「关键词零命中 → 全量补读向量」把最多 800 个 id 一次
//    塞进 `WHERE id IN (?,?,…)`，而 **D1 单条语句只允许 100 个绑定参数** ——
//    查询被拒后报错又被上层 catch 成「本次只用关键词」，表现为一条都检索不到。
//    node:sqlite 不会复现这个上限，所以这里用「参数个数守卫」把它钉住。
// 2) 重排序：默认关闭；开启后只改顺序、不改命中集合，失败自动回退。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { searchKnowledge, resolveRerankModel } from "../src/services/knowledge.js";
import { cacheClear } from "../src/services/cache.js";
import { KB } from "../src/config/constants.js";

const SCOPE = "global";
const RERANK = "@cf/baai/bge-reranker-base";

/** D1 官方限制：单条语句最多绑定 100 个参数 */
const D1_MAX_BOUND_PARAMS = 100;

/** 造 n 个分块（都在同一篇文档里） */
function seedChunks(db, count, contentOf = (i) => `完全无关的条目 ${i}`) {
  db.exec(
    `INSERT INTO kb_docs (scope_key, title, content, enabled, chunk_count)
     VALUES ('${SCOPE}', '资料', '正文', 1, ${count})`
  );
  const doc = db.get("SELECT id FROM kb_docs ORDER BY id DESC LIMIT 1");
  for (let i = 0; i < count; i++) {
    db.exec(
      `INSERT INTO kb_chunks (doc_id, scope_key, seq, content, dim, embedding, model)
       VALUES (${doc.id}, '${SCOPE}', ${i}, '${contentOf(i)}', 0, '', '')`
    );
  }
}

/** 造 n 个分块，每块一篇独立文档（绕开「同一篇文档最多取 2 块」的限制） */
function seedSeparateDocs(db, count, contentOf = (i) => `条目编号 ${i}`) {
  for (let i = 0; i < count; i++) {
    db.exec(
      `INSERT INTO kb_docs (scope_key, title, content, enabled, chunk_count)
       VALUES ('${SCOPE}', '资料 ${i}', '正文', 1, 1)`
    );
    const doc = db.get("SELECT id FROM kb_docs ORDER BY id DESC LIMIT 1");
    db.exec(
      `INSERT INTO kb_chunks (doc_id, scope_key, seq, content, dim, embedding, model)
       VALUES (${doc.id}, '${SCOPE}', 0, '${contentOf(i)}', 0, '', '')`
    );
  }
}

/**
 * AI 替身：把「向量化」与「重排序」分开计数。
 * rerank 行为可通过 impl 注入（返回结构 / 抛错）。
 */
function makeAI({ rerankImpl = null } = {}) {
  const calls = { embed: 0, rerank: 0 };

  const ai = {
    calls,
    run: async (_model, opts = {}) => {
      if (Array.isArray(opts.text)) {
        calls.embed++;
        return { data: opts.text.map(() => new Array(8).fill(0.1)) };
      }
      calls.rerank++;
      if (rerankImpl) return rerankImpl(opts);
      return { response: [] };
    }
  };
  return ai;
}

/** 统计 `SELECT id, embedding … WHERE id IN (…)` 每次绑定了多少个参数 */
function instrumentEmbedReads(db) {
  const stats = { batches: [], totalIds: 0, maxParams: 0 };
  const orig = db.prepare;
  db.prepare = (sql) => {
    const m = /SELECT id, embedding FROM kb_chunks WHERE id IN \(([^)]*)\)/.exec(sql);
    if (m) {
      const n = m[1].split(",").length;
      stats.batches.push(n);
      stats.totalIds += n;
      stats.maxParams = Math.max(stats.maxParams, n);
    }
    return orig(sql);
  };
  return stats;
}

function fresh() {
  cacheClear("kb-query-vec");
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  return db;
}

// ==========================================
// 1) 补读向量必须分批（D1 100 参数上限）
// ==========================================

test("关键词零命中触发全量补读时：按批读向量，单次绑定参数不超过 D1 上限", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  // 150 条 > 100：一次 IN 会被 D1 拒绝，正是 v3.8.0 的回归场景
  seedChunks(db, 150, (i) => `与问题毫无交集的条目 ${i}`);
  const stats = instrumentEmbedReads(db);
  const env = { DB: db, BOT_TOKEN: "T", AI: makeAI() };

  await searchKnowledge(env, SCOPE, "zzzz 完全不同的问法", { topK: 3 });

  assert.equal(stats.totalIds, 150, `零命中兜底时要补读全部 150 条，实际 ${stats.totalIds}`);
  assert.ok(stats.batches.length >= 2, `150 条必须拆成多批，实际 ${stats.batches.length} 批`);
  assert.ok(
    stats.maxParams <= D1_MAX_BOUND_PARAMS,
    `单次绑定参数 ${stats.maxParams} 超过 D1 上限 ${D1_MAX_BOUND_PARAMS}，查询会被直接拒绝`
  );
  db.close();
});

test("候选不多时仍然只读一批（不要为了分批而分批）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 12, (i) => `无关内容 ${i}`);
  const stats = instrumentEmbedReads(db);
  const env = { DB: db, BOT_TOKEN: "T", AI: makeAI() };

  await searchKnowledge(env, SCOPE, "zzzz 完全不同的问法", { topK: 3 });

  assert.equal(stats.batches.length, 1, "12 条应该一次读完");
  assert.equal(stats.maxParams, 12);
  db.close();
});

// ==========================================
// 2) 重排序：默认关闭
// ==========================================

test("重排序默认关闭：不额外调用模型", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 8, (i) => `条目 ${i}`);
  const ai = makeAI();
  const env = { DB: db, BOT_TOKEN: "T", AI: ai };

  await searchKnowledge(env, SCOPE, "zzzz 无关问法", { topK: 2, minScore: 0, strongScore: 0 });

  assert.equal(ai.calls.rerank, 0, "默认不该多花一次模型调用");
  db.close();
});

test("resolveRerankModel：未配置用内置值，off / none / 空串关闭", () => {
  assert.equal(resolveRerankModel({}), KB.RERANK_MODEL);
  assert.equal(resolveRerankModel({ KB_RERANK_MODEL: RERANK }), RERANK);
  assert.equal(resolveRerankModel({ KB_RERANK_MODEL: "off" }), "");
  assert.equal(resolveRerankModel({ KB_RERANK_MODEL: "none" }), "");
  assert.equal(resolveRerankModel({ KB_RERANK_MODEL: "  " }), "");
});

// ==========================================
// 3) 重排序：开启后的行为
// ==========================================

test("开启重排序：按模型分数改变顺序，命中集合不变", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedSeparateDocs(db, 6, (i) => `条目编号 ${i}`);
  // 模型把最后一条（index 5）判为最相关
  const ai = makeAI({
    rerankImpl: () => ({
      response: [
        { id: 5, score: 0.95 },
        { id: 1, score: 0.5 },
        { id: 0, score: 0.2 }
      ]
    })
  });
  const env = { DB: db, BOT_TOKEN: "T", AI: ai, KB_RERANK_MODEL: RERANK };

  const hits = await searchKnowledge(env, SCOPE, "zzzz 无关问法", {
    topK: 3, minScore: 0, strongScore: 0
  });

  assert.equal(ai.calls.rerank, 1, "开启后应该真的调了一次重排序模型");
  assert.equal(hits.length, 3);
  assert.ok(hits[0].content.includes("5"), `被模型提分的那条应排第一，实际：${hits[0].content}`);
  // 没有 rerank 分数的候选排在后面，但**一个都不能丢**
  const contents = hits.map((h) => h.content).sort();
  assert.deepEqual(
    contents,
    ["条目编号 0", "条目编号 1", "条目编号 5"].sort()
  );
  db.close();
});

test("重排序只在候选多于 TOP_K 时才调用（没必要就不烧额度）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 3, (i) => `条目 ${i}`);
  const ai = makeAI({ rerankImpl: () => ({ response: [{ id: 0, score: 1 }] }) });
  const env = { DB: db, BOT_TOKEN: "T", AI: ai, KB_RERANK_MODEL: RERANK };

  // 候选 3 条 = topK，重排没有意义
  await searchKnowledge(env, SCOPE, "zzzz 无关问法", { topK: 3, minScore: 0, strongScore: 0 });

  assert.equal(ai.calls.rerank, 0, "候选不超过 TOP_K 时不该调用模型");
  db.close();
});

test("重排序失败 / 返回垃圾：自动回退原排序，不影响检索结果", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 5, (i) => `条目 ${i}`);

  const baseline = await searchKnowledge(
    { DB: db, BOT_TOKEN: "T", AI: makeAI() }, SCOPE, "zzzz 无关问法",
    { topK: 3, minScore: 0, strongScore: 0 }
  );

  for (const impl of [
    () => { throw new Error("model down"); },
    () => ({ response: "不是数组" }),
    () => ({})
  ]) {
    cacheClear("kb-query-vec");
    const ai = makeAI({ rerankImpl: impl });
    const env = { DB: db, BOT_TOKEN: "T", AI: ai, KB_RERANK_MODEL: RERANK };
    const hits = await searchKnowledge(env, SCOPE, "zzzz 无关问法", {
      topK: 3, minScore: 0, strongScore: 0
    });
    assert.equal(ai.calls.rerank, 1, "确实尝试过重排序");
    assert.deepEqual(
      hits.map((h) => h.content),
      baseline.map((h) => h.content),
      "重排序不可用时必须保持原排序与原命中集合"
    );
  }
  db.close();
});
