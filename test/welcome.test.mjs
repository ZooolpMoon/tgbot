// ==========================================
// 👋 入群欢迎与人机验证（v3.9.0）
//
// 盯住四件事：
//   1. **默认不打扰**：功能开关默认关闭，没开就不该有任何动作
//   2. **限制要能收回**：验证通过 / 超时都要把发出去的权限收回来
//   3. **只发生一次**：连点验证、并发超时都由带条件的原子 UPDATE 兜住
//   4. **不给管理员添乱**：群主 / 管理员不能被限制（Telegram 会直接报错）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import { handleMessage } from "../src/handlers/message.js";
import { handleCallback } from "../src/handlers/callback.js";
import {
  getWelcomeConfig, setWelcomeConfig, clearWelcomeConfig,
  welcomeMessageText, memberDisplayName, welcomeScopeKey,
  processJoinVerifications
} from "../src/services/welcome.js";
import { getWelcomePanelKeyboard } from "../src/admin/welcome-panel.js";
import { setFeature } from "../src/services/features.js";
import { validateKeyboard, LAYOUT } from "../src/utils/layout.js";
import { WELCOME, ADMIN_CALLBACK } from "../src/config/constants.js";

// ---------- 测试替身 ----------

let apiCalls = [];
/** getChatMember 的返回状态（测试里按需改） */
let memberStatus = "member";

const reply = (payload) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => payload
});

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  if (method === "sendMessage") return reply({ ok: true, result: { message_id: 555 } });
  if (method === "getChatMember") return reply({ ok: true, result: { status: memberStatus } });
  return reply({ ok: true, result: true });
};

const resetCalls = () => { apiCalls.length = 0; };
const callsTo = (method) => apiCalls.filter((c) => c.method === method);
const textsSent = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));

const GROUP_CHAT = "-100123";
const GROUP_SCOPE = `group:${GROUP_CHAT}`;
const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai" });
const makeCtx = () => ({ pending: [], waitUntil(p) { this.pending.push(p); } });

const uctxOfGroup = (userId = "5") => ({
  chatId: GROUP_CHAT, userId, chatType: "supergroup",
  userKey: `user:${userId}`, sceneKey: `group:${GROUP_CHAT}:user:${userId}`,
  username: `u${userId}`, firstName: `成员${userId}`
});

/** 模拟「新成员入群」这条服务消息走完整入口 */
async function joinGroup(env, members, { chatTitle = "测试群" } = {}) {
  await handleMessage({
    env, ctx: makeCtx(), token: "T", myId: "999",
    uctx: uctxOfGroup("5"), isGroupCtx: true,
    payload: {
      message: {
        chat: { id: Number(GROUP_CHAT), type: "supergroup", title: chatTitle },
        new_chat_members: members
      }
    }
  });
}

/** 点一个按钮（走真实回调入口） */
const click = (env, data, userId = "5") => handleCallback({
  env, ctx: makeCtx(), token: "T", myId: "999",
  uctx: uctxOfGroup(userId),
  payload: {
    callback_query: {
      id: `cb_${data}`, from: { id: Number(userId) }, data,
      message: { message_id: 555, chat: { id: Number(GROUP_CHAT), type: "supergroup" } }
    }
  }
});

/** 把本群的欢迎功能与配置准备好 */
async function enableWelcome(env, { verify = false, kick = true, timeoutMin = 10, text = "" } = {}) {
  await setFeature(env, GROUP_SCOPE, "welcome", true);
  await setWelcomeConfig(env, GROUP_CHAT, "verify", verify ? "on" : "off");
  await setWelcomeConfig(env, GROUP_CHAT, "kick", kick ? "on" : "off");
  await setWelcomeConfig(env, GROUP_CHAT, "timeout_min", timeoutMin);
  if (text) await setWelcomeConfig(env, GROUP_CHAT, "text", text);
}

function fresh() {
  resetCalls();
  memberStatus = "member";
  const db = createTestDB();
  db.exec(`
    INSERT INTO users (user_key, user_id, username, first_name, points)
      VALUES ('user:5', '5', 'u5', '成员5', 100);
  `);
  return db;
}

const verificationRow = (db, userId = "5") =>
  db.get("SELECT * FROM join_verifications WHERE chat_id = ? AND user_id = ?", GROUP_CHAT, userId);

// ==========================================
// 1) 默认不打扰
// ==========================================

test("功能默认关闭：新成员入群时机器人一个字都不发", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);

  assert.equal(apiCalls.length, 0, "默认关闭时不该有任何 Telegram 调用");
  assert.equal(db.count("join_verifications"), 0, "也不该写验证记录");
  db.close();
});

test("只欢迎（未开验证）：发欢迎语，但不动权限", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: false, text: "欢迎 {name} 来到 {group}" });
  resetCalls();

  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);

  assert.ok(textsSent().some((t) => t.includes("欢迎 小明 来到 测试群")), `欢迎语要带成员名与群名：${textsSent()}`);
  assert.equal(callsTo("restrictChatMember").length, 0, "没开验证就不该限制发言");
  assert.equal(db.count("join_verifications"), 0, "没开验证也不该写记录");
  db.close();
});

test("机器人自己被拉进群时不欢迎自己", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  resetCalls();

  await joinGroup(env, [{ id: 999, first_name: "本机器人", is_bot: true }]);

  assert.equal(apiCalls.length, 0, "机器人入群不该触发欢迎或验证");
  db.close();
});

// ==========================================
// 2) 开启验证
// ==========================================

test("开启验证：先限制发言，再发带按钮的欢迎语，并落 pending 记录", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true, timeoutMin: 10 });
  resetCalls();

  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);

  const restricts = callsTo("restrictChatMember");
  assert.equal(restricts.length, 1, "应该限制一次发言");
  assert.equal(String(restricts[0].body.user_id), "5");
  assert.equal(restricts[0].body.permissions.can_send_messages, false, "限制要落到发消息权限上");

  const sent = apiCalls.find((c) => c.method === "sendMessage");
  assert.ok(sent, "要发欢迎语");
  assert.equal(
    sent.body.reply_markup.inline_keyboard[0][0].callback_data,
    ADMIN_CALLBACK.JOIN_VERIFY_OK,
    "按钮要指向「通过验证」"
  );

  const row = verificationRow(db);
  assert.ok(row, "要写下验证记录");
  assert.equal(row.status, "pending");
  assert.equal(Number(row.verify_msg_id), 555, "要记住卡片 ID，通过后好收按钮");
  assert.ok(Number(row.until_at) > Math.floor(Date.now() / 1000), "到期时间应在未来");
  db.close();
});

test("群主 / 管理员入群：不限制，只欢迎", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  memberStatus = "creator";
  resetCalls();

  await joinGroup(env, [{ id: 5, first_name: "群主", is_bot: false }]);

  assert.equal(callsTo("restrictChatMember").length, 0, "群主不能被限制（Telegram 也会拒绝）");
  assert.ok(textsSent().length > 0, "但还是欢迎一下");
  assert.equal(db.count("join_verifications"), 0, "没有限制就不需要验证");
  db.close();
});

test("机器人没有「封禁用户」权限时降级为只欢迎", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });

  // 让 restrictChatMember 返回业务失败
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split("/").pop();
    if (method === "restrictChatMember") {
      return reply({ ok: false, description: "Bad Request: not enough rights" });
    }
    return orig(url, opts);
  };
  resetCalls();

  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);

  assert.ok(textsSent().length > 0, "限制失败也要欢迎");
  assert.doesNotMatch(textsSent().join("\n"), /通过验证/, "没限制成功就不该要求点验证");
  assert.equal(db.count("join_verifications"), 0);
  globalThis.fetch = orig;
  db.close();
});

// ==========================================
// 3) 通过验证
// ==========================================

test("点「我已阅读群规」：原子置为 passed、解除限制、收起按钮", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  resetCalls();

  await click(env, ADMIN_CALLBACK.JOIN_VERIFY_OK, "5");

  assert.equal(verificationRow(db).status, "passed");
  const restricts = callsTo("restrictChatMember");
  assert.equal(restricts.length, 1, "要通过时解除一次限制");
  assert.equal(restricts[0].body.permissions.can_send_messages, true, "解除限制 = 放开发消息");
  assert.equal(callsTo("editMessageReplyMarkup").length, 1, "要把按钮收掉");
  assert.ok(
    callsTo("answerCallbackQuery").some((c) => /验证通过/.test(String(c.body.text))),
    "要给点击者一个明确回执"
  );
  db.close();
});

test("连点两次验证按钮：只解除一次限制", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  resetCalls();

  await click(env, ADMIN_CALLBACK.JOIN_VERIFY_OK, "5");
  await click(env, ADMIN_CALLBACK.JOIN_VERIFY_OK, "5");   // 连点

  assert.equal(callsTo("restrictChatMember").length, 1, "第二次不该再解除一次");
  assert.ok(
    callsTo("answerCallbackQuery").some((c) => /已经处理过/.test(String(c.body.text))),
    "第二次要明确回「已经处理过」"
  );
  db.close();
});

test("验证按钮只能通过自己的验证（别人的 pending 不受影响）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  await joinGroup(env, [{ id: 6, first_name: "小红", is_bot: false }]);
  resetCalls();

  // 6 号点按钮：只能通过 6 号自己
  await click(env, ADMIN_CALLBACK.JOIN_VERIFY_OK, "6");

  assert.equal(verificationRow(db, "6").status, "passed");
  assert.equal(verificationRow(db, "5").status, "pending", "不该顺手把别人也放行");
  const lifted = callsTo("restrictChatMember").filter((c) => String(c.body.user_id) === "5");
  assert.equal(lifted.length, 0, "也不该解除别人的限制");
  db.close();
});

// ==========================================
// 4) 超时处理
// ==========================================

/** 把验证记录改成「已到期」 */
function expireVerification(db, userId = "5") {
  db.exec(
    `UPDATE join_verifications SET until_at = ${Math.floor(Date.now() / 1000) - 60}
      WHERE chat_id = '${GROUP_CHAT}' AND user_id = '${userId}'`
  );
}

test("超时未验证：默认移出群聊（先封再解，允许以后重新加入）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true, kick: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  expireVerification(db, "5");
  resetCalls();

  const res = await processJoinVerifications(env, "T");

  assert.equal(res.checked, 1);
  assert.equal(res.kicked, 1);
  assert.equal(callsTo("banChatMember").length, 1, "要移出群聊");
  assert.equal(callsTo("unbanChatMember").length, 1, "顺手解封 = 以后还能重新加入");
  assert.equal(verificationRow(db).status, "expired");
  db.close();
});

test("超时未验证 + 配置为不移出：必须解除限制，不能变成永久禁言", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true, kick: false });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  expireVerification(db, "5");
  resetCalls();

  const res = await processJoinVerifications(env, "T");

  assert.equal(res.released, 1);
  assert.equal(callsTo("banChatMember").length, 0, "不该踢人");
  const restricts = callsTo("restrictChatMember");
  assert.equal(restricts.length, 1);
  assert.equal(restricts[0].body.permissions.can_send_messages, true, "要放开权限");
  db.close();
});

test("已通过的记录不会被超时处理误伤", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true, kick: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  await click(env, ADMIN_CALLBACK.JOIN_VERIFY_OK, "5");   // 先通过验证
  expireVerification(db, "5");                            // 再把它改成过期时间
  resetCalls();

  const res = await processJoinVerifications(env, "T");

  assert.equal(res.checked, 0, "passed 的记录不该被处理");
  assert.equal(callsTo("banChatMember").length, 0, "已经通过验证的人不能被踢");
  assert.equal(verificationRow(db).status, "passed");
  db.close();
});

test("超时处理只处理到期的记录，未来的记录不动", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);
  await enableWelcome(env, { verify: true });
  await joinGroup(env, [{ id: 5, first_name: "小明", is_bot: false }]);
  resetCalls();

  const res = await processJoinVerifications(env, "T");

  assert.equal(res.checked, 0, "还没到期，什么都不该做");
  assert.equal(verificationRow(db).status, "pending");
  db.close();
});

// ==========================================
// 5) 文案、配置与排版
// ==========================================

test("欢迎语文案：占位符替换 + 成员名字里的尖括号必须转义", () => {
  const text = welcomeMessageText(
    { text: "欢迎 {name} 来到 {group}", timeoutMin: 10, kick: true },
    { name: "<b>坏名字</b>", group: "测试群", restricted: false }
  );
  assert.ok(text.includes("测试群"));
  assert.ok(!text.includes("<b>坏名字</b>"), "成员名字是用户可控的，必须转义后再进 HTML");
  assert.ok(text.includes("&lt;b&gt;"));

  const restricted = welcomeMessageText(
    { text: "欢迎 {name}", timeoutMin: 5, kick: true },
    { name: "小明", restricted: true }
  );
  assert.match(restricted, /完成验证后即可发言/);
  assert.match(restricted, /5 分钟内未验证/);
  assert.match(restricted, /移出群聊/);
});

test("未配置欢迎语时用内置默认模板", () => {
  const text = welcomeMessageText({}, { name: "小明", group: "测试群" });
  assert.ok(text.includes("小明"));
  assert.ok(text.includes("测试群"));
  assert.ok(WELCOME.DEFAULT_TEXT.includes("{name}"), "默认模板本身应含占位符");
});

test("memberDisplayName：姓名优先，退到用户名，再退到通用称呼", () => {
  assert.equal(memberDisplayName({ first_name: "小", last_name: "明" }), "小 明");
  assert.equal(memberDisplayName({ first_name: "小明" }), "小明");
  assert.equal(memberDisplayName({ username: "ming" }), "ming");
  assert.equal(memberDisplayName({}), "新朋友");
});

test("群级配置读写往返，并且能恢复默认", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  assert.equal(await getWelcomeConfig(env, GROUP_CHAT).then((c) => c.verify), false, "默认不验证");
  assert.equal(await getWelcomeConfig(env, GROUP_CHAT).then((c) => c.timeoutMin), WELCOME.DEFAULT_TIMEOUT_MIN);

  await setWelcomeConfig(env, GROUP_CHAT, "verify", "on");
  await setWelcomeConfig(env, GROUP_CHAT, "timeout_min", 30);
  await setWelcomeConfig(env, GROUP_CHAT, "text", "你好 {name}");

  const config = await getWelcomeConfig(env, GROUP_CHAT);
  assert.equal(config.verify, true);
  assert.equal(config.timeoutMin, 30);
  assert.equal(config.text, "你好 {name}");

  // 配置写在群作用域上（不是成员级 sceneKey），否则每个管理员各配一份
  const row = db.get("SELECT scene_key FROM scene_settings WHERE name = 'welcome.verify'");
  assert.equal(row.scene_key, welcomeScopeKey(GROUP_CHAT));
  assert.equal(row.scene_key, GROUP_SCOPE);

  await clearWelcomeConfig(env, GROUP_CHAT, "text");
  assert.equal((await getWelcomeConfig(env, GROUP_CHAT)).text, "", "清掉后回落默认");
  db.close();
});

test("面板键盘符合排版约定，且按钮反映当前配置", () => {
  const keyboard = getWelcomePanelKeyboard({ enabled: true, verify: true, kick: false, timeoutMin: 10 });
  assert.deepEqual(validateKeyboard(keyboard), [], "排版必须符合 layout.js 的约定");
  const labels = keyboard.inline_keyboard.flat().map((b) => b.text).join(" | ");
  assert.match(labels, /已开启/);
  assert.match(labels, /验证：开启/);
  assert.match(labels, /超时移出：否/);
  assert.match(labels, /10 分钟/);
  assert.ok(keyboard.inline_keyboard.length <= LAYOUT.MAX_ROWS);
});
