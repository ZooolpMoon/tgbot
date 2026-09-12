// ==========================================
// 📐 菜单排版（避免长条，统一两列网格）
//
// 覆盖所有「会随数据量增长」的菜单：
// 管理员主菜单、功能开关、任务列表、用户列表、商城（用户侧 / 管理侧）、游戏。
// 约束来自 src/utils/layout.js：单行 ≤ 2 个按钮、整菜单 ≤ 8 行、
// 按钮文案 ≤ 32 字、callback_data ≤ 64 字节。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT, grid, compactLabel, clampPage, totalPagesOf, pagerRow, validateKeyboard
} from "../src/utils/layout.js";

import { getAdminMainKeyboard, getUserManageKeyboard } from "../src/admin/menus.js";
import { getFeatureHomeKeyboard } from "../src/admin/features.js";
import { getUserPointsKeyboard } from "../src/admin/user-points.js";
import { getUserLimitKeyboard } from "../src/admin/user-limit.js";
import { getUserRateKeyboard } from "../src/admin/user-rate.js";
import { getUserListKeyboard } from "../src/admin/user-list.js";
import { getGroupListKeyboard, getGroupMembersKeyboard } from "../src/admin/user-groups.js";
import { getBannedListKeyboard } from "../src/admin/user-banned.js";
import { getKnowledgeHomeKeyboard, getDocumentListKeyboard } from "../src/admin/knowledge.js";
import { getGuardCardKeyboard } from "../src/admin/guard.js";
import { getGuardPanelKeyboard, getGuardHistoryKeyboard } from "../src/admin/guard-panel.js";
import { getAppealCardKeyboard } from "../src/admin/guard.js";
import { getLogFilterKeyboard } from "../src/admin/logs.js";

import { getShopAdminHomeKeyboard, getShopAdminItemsKeyboard, getShopAdminOrdersKeyboard } from "../src/shop/admin.js";
import { getShopHomeKeyboard, getMyOrdersKeyboard } from "../src/shop/index.js";
import { getTagGroupKeyboard } from "../src/shop/tags.js";
import { buildItemEditKeyboard } from "../src/shop/edit.js";

import { getGameCenterKeyboard } from "../src/games/index.js";
import { getCustomBetKeyboard, getGameMainKeyboard } from "../src/games/shared.js";

/** 断言键盘符合排版约定 */
function assertCompact(keyboard, { maxRows = LAYOUT.MAX_ROWS, label = "菜单" } = {}) {
  const problems = validateKeyboard(keyboard);
  assert.deepEqual(problems, [], `${label} 排版不合规：${problems.join("；")}`);
  assert.ok(
    keyboard.inline_keyboard.length <= maxRows,
    `${label} 有 ${keyboard.inline_keyboard.length} 行，超过上限 ${maxRows}`
  );
}

// ---------- 工具本身 ----------

test("grid 按每行 N 个切分；compactLabel 按码点截断（不切坏 emoji）", () => {
  assert.deepEqual(grid([1, 2, 3, 4, 5]), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(grid([1, 2, 3], 3), [[1, 2, 3]]);

  assert.equal(compactLabel("短文案"), "短文案");
  const long = compactLabel("🎲".repeat(40), 10);
  assert.equal(Array.from(long).length, 10);
  assert.equal(long, "🎲".repeat(9) + "…");
});

test("页码工具：收敛越界页码、生成翻页行", () => {
  assert.equal(totalPagesOf(0, 8), 1);
  assert.equal(totalPagesOf(9, 8), 2);
  assert.equal(clampPage(5, 2), 2);
  assert.equal(clampPage(0, 2), 1);
  assert.equal(clampPage("bad", 3), 1);

  assert.equal(pagerRow({ page: 1, totalPages: 1, prefix: "p_" }), null);
  const row = pagerRow({ page: 2, totalPages: 3, prefix: "p_" });
  assert.deepEqual(row.map((b) => b.callback_data), ["p_1", "p_3"]);
});

test("validateKeyboard 能发现超行数 / 超按钮数 / 超长文案", () => {
  const tooManyRows = { inline_keyboard: Array.from({ length: 9 }, () => [{ text: "x", callback_data: "y" }]) };
  assert.ok(validateKeyboard(tooManyRows).some((p) => p.includes("超过上限")));

  const threeInRow = {
    inline_keyboard: [[
      { text: "a", callback_data: "1" },
      { text: "b", callback_data: "2" },
      { text: "c", callback_data: "3" }
    ]]
  };
  assert.ok(validateKeyboard(threeInRow).some((p) => p.includes("3 个按钮")));

  const longText = { inline_keyboard: [[{ text: "字".repeat(40), callback_data: "x" }]] };
  assert.ok(validateKeyboard(longText).some((p) => p.includes("文案过长")));
});

// ---------- 管理员菜单 ----------

test("管理员主菜单：两列网格、行数受控、关闭按钮独立一行", () => {
  const kb = getAdminMainKeyboard(true);
  assertCompact(kb, { maxRows: 7, label: "管理员主菜单" });

  const last = kb.inline_keyboard.at(-1);
  assert.equal(last.length, 1, "关闭按钮应单独占一行");
  assert.equal(last[0].callback_data, "admin_close");
});

test("群聊里的管理菜单不显示商城入口，排版同样紧凑", () => {
  const kb = getAdminMainKeyboard(false);
  const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!flat.includes("shop_admin_home"), "群聊不应有商城入口");
  assertCompact(kb, { maxRows: 7, label: "管理员主菜单（群聊）" });
});

test("主菜单包含全部管理入口", () => {
  const flat = getAdminMainKeyboard(true).inline_keyboard.flat().map((b) => b.callback_data);
  for (const expect of [
    "admin_users_home", "admin_kb", "shop_admin_home",
    "admin_codes_1", "admin_feat_home", "admin_autodel", "admin_logs_1",
    "admin_status", "admin_stats", "admin_close"
  ]) {
    assert.ok(flat.includes(expect), `缺少入口 ${expect}`);
  }
  // 私聊 / 群组用户已收进二级菜单，不应再出现在主菜单
  assert.ok(!flat.includes("admin_users_private_1"), "主菜单不应直接放私聊用户入口");
  assert.ok(!flat.includes("admin_users_group_1"), "主菜单不应直接放群组用户入口");
});

test("用户管理二级菜单：私聊 / 群组用户 + 返回主菜单", () => {
  const kb = getUserManageKeyboard();
  assertCompact(kb, { maxRows: 2, label: "用户管理菜单" });

  const rows = kb.inline_keyboard;
  assert.deepEqual(rows[0].map((b) => b.callback_data), ["admin_users_private_1", "admin_users_group_1"]);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ["admin_banned_1", "admin_main_menu"]);
});

test("群组用户：群列表 → 群成员，两级都不超过 8 行", () => {
  const groups = Array.from({ length: 6 }, (_, i) => ({
    chat_id: `-10012345678${i}`, members: i + 1, updated_at: "2026-09-12 10:00:00"
  }));
  const groupKb = getGroupListKeyboard(groups, 1, 1);
  assertCompact(groupKb, { maxRows: 6, label: "群列表" });
  // 按钮回调里要能带回群 ID（页码用结尾的 _1）
  const first = groupKb.inline_keyboard[0][0];
  assert.equal(first.callback_data, "admin_group_m_-100123456780_1");

  const members = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, first_name: `成员名字很长${i}`, user_id: String(1000 + i), points: 100, blocked: i % 2
  }));
  const memberKb = getGroupMembersKeyboard(members, 1, 1, "-100123456780");
  assertCompact(memberKb, { maxRows: 5, label: "群成员列表" });
  assert.ok(memberKb.inline_keyboard.flat().some((b) => b.text.startsWith("🚫")));
});

test("封禁名单：每行一个解封按钮，页面不会太长", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, first_name: `被封禁用户${i}`, user_id: String(2000 + i), points: 0
  }));
  const kb = getBannedListKeyboard(rows, 1, 1);
  assertCompact(kb, { maxRows: 7, label: "封禁名单" });
  assert.equal(kb.inline_keyboard[0].length, 1, "解封按钮每行一个，避免误触");
  assert.equal(kb.inline_keyboard[0][0].callback_data, "admin_unban_1_1");
});

test("知识库面板：首页与文档列表排版紧凑", () => {
  assertCompact(getKnowledgeHomeKeyboard(), { maxRows: 4, label: "知识库首页" });

  const docs = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, title: `很长的文档标题${i}`, enabled: 1, chunk_count: 12
  }));
  const listKb = getDocumentListKeyboard(docs, 1, 1);
  assertCompact(listKb, { maxRows: 6, label: "文档列表" });
});

test("群规执法确认卡片：确认/取消与切换处置都在两列网格内", () => {
  const kb = getGuardCardKeyboard({ id: 12, action: "bot_ban" });
  assertCompact(kb, { maxRows: 5, label: "执法确认卡片" });

  const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.includes("guard_go_12"));
  assert.ok(flat.includes("guard_no_12"));
  assert.ok(flat.includes("guard_set_12_mute"));
  assert.ok(!flat.includes("guard_set_12_bot_ban"), "当前处置方式不应再出现在切换按钮里");
});

test("群规面板与处置记录排版紧凑", () => {
  const panel = getGuardPanelKeyboard({ enabled: 1, default_action: "bot_ban", default_mute_minutes: 60 });
  assertCompact(panel, { maxRows: 6, label: "群规面板" });
  const keys = panel.inline_keyboard.flat().map((b) => b.callback_data);
  for (const expect of [
    "admin_guard_rules", "admin_guard_append", "admin_guard_act_menu",
    "admin_guard_mute_menu", "admin_guard_toggle", "admin_guard_clearrules",
    "admin_guard_hist_1", "admin_main_menu"
  ]) {
    assert.ok(keys.includes(expect), `群规面板缺少 ${expect}`);
  }

  // 关闭执法时按钮文案要变，但仍是一行
  const off = getGuardPanelKeyboard({ enabled: 0 });
  assert.ok(off.inline_keyboard.flat().some((b) => b.text.includes("开启执法")));

  assertCompact(getGuardHistoryKeyboard([], 1, 1), { maxRows: 2, label: "处置记录" });
});

test("处置记录带撤销按钮时也不超过 8 行", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, action: "mute", status: i === 4 ? "cancelled" : "done", user_label: `用户${i}`
  }));
  const kb = getGuardHistoryKeyboard(rows, 1, 1);
  assertCompact(kb, { maxRows: 8, label: "处置记录（含撤销）" });
  // 已取消的那条不给撤销按钮
  assert.equal(kb.inline_keyboard.filter((r) => r[0].callback_data.startsWith("admin_guard_rev_")).length, 4);
});

test("申诉卡片：撤销 / 驳回两列一行", () => {
  const kb = getAppealCardKeyboard(7);
  assertCompact(kb, { maxRows: 1, label: "申诉卡片" });
  assert.deepEqual(kb.inline_keyboard[0].map((b) => b.callback_data), ["appeal_ok_7", "appeal_no_7"]);
});

test("操作日志筛选菜单：9 个筛选项 + 翻页 + 返回不超过 8 行", () => {
  const kb = getLogFilterKeyboard("guard", 1, 3);
  assertCompact(kb, { maxRows: 8, label: "日志筛选" });
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.text.startsWith("✅") && b.text.includes("执法")), "当前筛选要有标记");
  assert.ok(flat.some((b) => b.callback_data === "admin_logs_f_guard_2"), "翻页要带上筛选条件");
  assert.ok(flat.some((b) => b.callback_data === "admin_logs_f_admins_1"), "应有管理员筛选");
  assert.ok(flat.some((b) => b.callback_data === "admin_logs_f_autodelete_1"), "应有自动删除筛选");
});

test("功能开关首页：三级入口都是两列网格", () => {
  const kb = getFeatureHomeKeyboard();
  assertCompact(kb, { maxRows: 4, label: "功能开关首页" });
  const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(flat, ["admin_feat_g", "admin_feat_gl_1", "admin_feat_pl_1", "admin_main_menu"]);
});

test("用户管理模式键盘（积分 / 限额 / 频率）都是两列且行数受控", () => {
  assertCompact(getUserPointsKeyboard(123, 1000000), { maxRows: 5, label: "积分管理" });
  assertCompact(getUserLimitKeyboard(123), { maxRows: 4, label: "限额管理" });
  assertCompact(getUserRateKeyboard(123), { maxRows: 5, label: "频率管理" });

  // 「清零」按钮必须正好抵消当前积分
  const clearBtn = getUserPointsKeyboard(7, 250).inline_keyboard.flat()
    .find((b) => b.text === "清零积分");
  assert.equal(clearBtn.callback_data, "admin_modpts_7:-250");
});

test("用户列表（私聊 / 群聊）：8 个场景仍不超过 6 行", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    first_name: `很长的用户名字${i}`,
    user_id: String(1000 + i),
    chat_id: `-10012345678${i}`,
    points: 100
  }));

  assertCompact(getUserListKeyboard(rows, 1, 1, true), { maxRows: 6, label: "私聊场景列表" });
  assertCompact(getUserListKeyboard(rows, 1, 1, false), { maxRows: 6, label: "群聊场景列表" });
  // 群聊按钮里应带上群 ID 尾号，避免不同群的同名用户混淆
  const groupLabels = getUserListKeyboard(rows, 1, 1, false).inline_keyboard.flat()
    .filter((b) => b.callback_data.startsWith("admin_manage_user_"))
    .map((b) => b.text);
  assert.equal(groupLabels.length, 8);
  assert.ok(groupLabels.every((t) => t.startsWith("🏠…")));
});

// ---------- 商城 ----------

test("商城管理首页与商品编辑面板：两列网格", () => {
  assertCompact(getShopAdminHomeKeyboard(), { maxRows: 4, label: "商城管理首页" });

  const editKb = buildItemEditKeyboard(9);
  assertCompact(editKb, { maxRows: 6, label: "商品编辑面板" });
  const fields = editKb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const f of ["name", "price", "stock", "limit", "category", "icon", "description"]) {
    assert.ok(fields.includes(`shop_admin_editf_9_${f}`), `商品编辑面板缺少字段 ${f}`);
  }
});

test("商城用户侧：8 件商品 / 5 条待处理订单都不超过 8 行", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `超长商品名称${i}`, icon: "🎁", price: 100
  }));
  assertCompact(getShopHomeKeyboard(items, 1, 1), { maxRows: 8, label: "商城首页" });

  const orders = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, order_no: `S1ABCDEF23${i}`, status: "pending"
  }));
  assertCompact(getMyOrdersKeyboard(orders, 1, 1), { maxRows: 8, label: "我的订单" });
});

test("群标签选群面板：一页 10 个群 + 翻页 + 放弃不超过 8 行", () => {
  const groups = Array.from({ length: 10 }, (_, i) => ({
    chatId: `-10012345678${i}`, title: `一个名字比较长的群聊${i}`
  }));
  assertCompact(getTagGroupKeyboard(groups, 1, 2), { maxRows: 8, label: "选群面板" });
  // 单页（没有翻页行）时更短
  assertCompact(getTagGroupKeyboard(groups.slice(0, 4), 1, 1), { maxRows: 8, label: "选群面板（单页）" });
});

test("商城管理侧：商品列表与订单列表分页后仍然紧凑", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `商品${i}`, icon: "🎁", price: 10, enabled: i % 2
  }));
  assertCompact(getShopAdminItemsKeyboard(items, 1, 1), { maxRows: 7, label: "商品列表" });

  const orders = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, order_no: `S1ABCDEF23${i}`, status: ["pending", "done", "cancelled"][i % 3]
  }));
  assertCompact(getShopAdminOrdersKeyboard(orders, 1, 1, "pending"), { maxRows: 6, label: "订单列表" });
});

// ---------- 游戏 ----------

test("游戏大厅与各游戏主界面：两列网格 + 独立返回行", () => {
  assertCompact(getGameCenterKeyboard(), { maxRows: 4, label: "游戏大厅" });

  for (const game of ["dice", "slots", "coin", "wheel"]) {
    assertCompact(getGameMainKeyboard(game), { maxRows: 4, label: `${game} 主界面` });
  }
});

test("自定义下注面板：金额调整不超过两列，确认按钮独立一行", () => {
  const kb = getCustomBetKeyboard("dice", 123456);
  assertCompact(kb, { maxRows: 6, label: "自定义下注" });
  const confirm = kb.inline_keyboard.find(
    (row) => row.length === 1 && row[0].callback_data.startsWith("game_dice_bet_")
  );
  assert.ok(confirm, "应有一个独立的确认下注按钮");
});
