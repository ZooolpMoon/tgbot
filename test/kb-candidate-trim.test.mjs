// ==========================================
// 📚 知识库检索的「候选裁剪」（v3.8.0）
//
// 背景：`embedding` 是 base64(1024 维 Float32) ≈ **5.4KB/块**，而检索原先把整个
// 知识库（上限 400 块）连同向量一起读进内存 —— 满库时约 **2MB/条消息**，
// 最终却只用得上 TOP_K(4) 条。
//
// 修法：先读轻量列 → 用关键词给候选排序 → 只给最有希望的一小批补读向量；
// **关键词完全没命中时仍然全量读取**（纯语义检索的能力不能丢）。
// 这个文件同时盯住「省了」和「没省坏」。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { searchKnowledge } from "../src/services/knowledge.js";
import { cacheClear } from "../src/services/cache.js";
import { KB } from "../src/config/constants.js";

const SCOPE = "global";

/** 包装 db.prepare 统计「整表带向量读」与「按 id 补读」的次数/条数 */
function instrument(db) {
  const stats = { fullTableReads: 0, idReads: 0, lastIdCount: 0 };
  const orig = db.prepare;
  db.prepare = (sql) => {
    if (/c\.embedding/.test(sql)) stats.fullTableReads++;
    const m = /SELECT id, embedding FROM kb_chunks WHERE id IN \(([^)]*)\)/.exec(sql);
    if (m) {
      stats.idReads++;
      stats.lastIdCount = m[1].split(",").length;
    }
    return orig(sql);
  };
  return stats;
}

const makeAI = () => ({
  run: async (_model, opts) => {
    const texts = Array.isArray(opts?.text) ? opts.text : [opts?.text];
    // 1024 维，保证与库里 dim 对得上
    return { data: texts.map(() => new Array(1024).fill(0.01)) };
  }
});
const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", APP_TIMEZONE: "Asia/Shanghai", AI: makeAI(), ...extra
});

/** 造 n 个分块（默认都没向量，dim=0，走关键词路径） */
function seedChunks(db, count, contentOf = (i) => `第${i}条资料内容`) {
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

function fresh() {
  cacheClear("kb-query-vec");
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  return db;
}

test("关键词有命中时：不再整表读向量，只按 id 补读一小批", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  // 60 条资料，只有 1 条跟「签到」有关
  seedChunks(db, 60, (i) => (i === 7 ? "签到每天可以领积分，连续签到奖励更高" : `无关资料 ${i} 的内容`));
  const stats = instrument(db);
  const env = makeEnv(db);

  const hits = await searchKnowledge(env, SCOPE, "签到积分怎么领", { topK: 3 });

  assert.equal(stats.fullTableReads, 0, "关键词已命中，不该再把整表连向量一起读出来");
  assert.ok(hits.length > 0, "应该检索到那条签到资料");
  assert.ok(hits.some((h) => h.content.includes("签到")), "命中的就是签到那条");
  db.close();
});

test("关键词完全没命中时：退回全量读取（保住纯语义检索）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 50, (i) => `完全无关的条目 ${i}`);
  const stats = instrument(db);
  const env = makeEnv(db);

  await searchKnowledge(env, SCOPE, "zzz 完全没有交集的问法", { topK: 3 });

  // 关键词一条都没命中 → 候选必须覆盖全部（否则纯语义检索就废了）
  assert.equal(stats.lastIdCount, 50, `兜底时应该补读全部 50 条，实际 ${stats.lastIdCount}`);
  db.close();
});

test("候选裁剪的规模上限：补读条数不超过预筛上限", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  // 100 条资料，**都**含「积分」→ 关键词全命中，此时必须靠预筛上限收口
  seedChunks(db, 100, (i) => `积分相关条目 ${i}`);
  const stats = instrument(db);
  const env = makeEnv(db);

  await searchKnowledge(env, SCOPE, "积分", { topK: 3 });

  assert.ok(stats.lastIdCount > 0, "应该补读了向量");
  assert.ok(stats.lastIdCount <= 40, `补读条数要收敛（实际 ${stats.lastIdCount}）`);
  assert.equal(stats.fullTableReads, 0);
  db.close();
});

test("裁剪不影响功能：无向量时仍按关键词检索到正确资料", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  seedChunks(db, 30, (i) => (i === 3 ? "兑换码在私聊里用 /redeem 兑换" : `其它说明 ${i}`));
  const env = makeEnv(db, { AI: null });   // 没有 AI 绑定 → 走关键词路径

  const hits = await searchKnowledge(env, SCOPE, "redeem 兑换码", { topK: 3 });

  assert.ok(hits.length > 0, "没有向量时也要能检索到");
  assert.ok(hits[0].content.includes("兑换码"), `最相关的应该在前面，实际：${hits[0].content}`);
  db.close();
});

test("裁剪不影响功能：有向量时语义相近的资料仍能被检索到", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  // 造一条「有真实向量」的资料：向量与查询向量同向
  seedChunks(db, 10, (i) => (i === 2 ? "怎么签到领取积分" : `普通条目 ${i}`));
  const vec = new Array(1024).fill(0.01);
  const b64 = Buffer.from(new Float32Array(vec).buffer).toString("base64");
  db.exec(
    `UPDATE kb_chunks SET embedding = '${b64}', dim = ${KB.EMBED_DIM || 1024}
     WHERE seq = 2`
  );
  const env = makeEnv(db);

  const hits = await searchKnowledge(env, SCOPE, "签到积分", { topK: 3 });

  assert.ok(hits.length > 0, "应能命中");
  assert.ok(hits[0].content.includes("签到"), `语义+关键词最相关的那条应排第一，实际：${hits[0].content}`);
  db.close();
});
