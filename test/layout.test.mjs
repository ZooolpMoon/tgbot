// ==========================================
// 📐 菜单排版（避免长条，两列网格）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { getAdminMainKeyboard } from "../src/admin/menus.js";

// Telegram 限制：callback_data ≤ 64 字节
const MAX_CALLBACK_BYTES = 64;

function assertCompact(keyboard, { maxPerRow = 2, maxRows = 8, label = "菜单" } = {}) {
  assert.ok(keyboard?.inline_keyboard?.length > 0, `${label} 没有按钮`);
  assert.ok(
    keyboard.inline_keyboard.length <= maxRows,
    `${label} 有 ${keyboard.inline_keyboard.length} 行，超过上限 ${maxRows}（会被拉成长条）`
  );
  for (const [i, row] of keyboard.inline_keyboard.entries()) {
    assert.ok(row.length <= maxPerRow, `${label} 第 ${i + 1} 行有 ${row.length} 个按钮（上限 ${maxPerRow}）`);
    for (const btn of row) {
      assert.ok(btn.text && btn.text.length > 0, "按钮必须有文案");
      assert.ok(btn.text.length <= 32, `按钮文案过长：${btn.text}`);
      assert.ok(
        Buffer.byteLength(String(btn.callback_data), "utf8") <= MAX_CALLBACK_BYTES,
        `callback_data 超过 64 字节：${btn.callback_data}`
      );
    }
  }
}

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
    "admin_users_private_1", "admin_users_group_1", "shop_admin_home",
    "admin_codes_1", "admin_tasks", "admin_feat_home", "admin_logs_1",
    "admin_status", "admin_stats", "admin_close"
  ]) {
    assert.ok(flat.includes(expect), `缺少入口 ${expect}`);
  }
});
