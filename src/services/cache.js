// ==========================================
// ⚡ isolate 级 TTL 缓存（v3.0.0）
//
// 背景：Workers 里每一次请求都是独立的，但**同一个 isolate 会复用**。
// 而像「功能开关」「消息自动删除时长」这类配置，每条群消息都要读一次，
// 成本全是 D1 查询。这里做一个极简的 TTL 缓存：
//   • 只在 isolate 内存里，进程重启/换 isolate 自动失效（不会读到脏数据太久）
//   • **写路径主动失效**（setFeature / setAutoDeleteSeconds 等都会 clear），
//     所以「管理员改完立刻生效」是有保证的；TTL 只是兜底。
// ==========================================

const STORES = new Map();

// 缓存必须按「数据库实例」隔离：生产只有一个 D1，但测试里每个用例都有自己的内存库，
// 只按 scene key 缓存会让不同测试互相读到对方的配置。用 WeakMap 记住每个 DB 的编号。
const DB_IDS = new WeakMap();
let nextDbId = 1;
function scopeToken(db) {
  if (!db || typeof db !== "object") return "no-db";
  let id = DB_IDS.get(db);
  if (!id) {
    id = nextDbId++;
    DB_IDS.set(db, id);
  }
  return `db${id}`;
}

/** 取（或创建）一个命名空间 */
function storeOf(namespace) {
  let store = STORES.get(namespace);
  if (!store) {
    store = new Map();
    STORES.set(namespace, store);
  }
  return store;
}

/** 读缓存；过期或不存在返回 undefined */
export function cacheGet(namespace, key, db = null) {
  const store = storeOf(namespace);
  const hit = store.get(`${scopeToken(db)}|${key}`);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

/** 写缓存（默认 30 秒） */
export function cacheSet(namespace, key, value, ttlMs = 30000, db = null) {
  const store = storeOf(namespace);
  // 简单容量保护：超过 500 条直接清空（配置数量本来就不该这么多）
  if (store.size > 500) store.clear();
  store.set(`${scopeToken(db)}|${key}`, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** 清某个命名空间（不传 key 则整块清） */
export function cacheClear(namespace, key = null) {
  const store = storeOf(namespace);
  if (key === null) store.clear();
  else store.delete(key);
}

/** 清掉所有命名空间（测试与「重置配置」时用） */
export function cacheClearAll() {
  STORES.clear();
}
