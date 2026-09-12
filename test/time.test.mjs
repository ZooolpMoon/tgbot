// ==========================================
// 🕒 时区：库里一律存 UTC，给人看的时候换算到应用时区（默认北京时间 UTC+8）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAppTime, getAppTimeZone, getDateKey, nowAppTime
} from "../src/services/time.js";

const BEIJING = { APP_TIMEZONE: "Asia/Shanghai" };

test("formatAppTime：SQLite 里的 UTC 时间按北京时间展示（+8）", () => {
  // CURRENT_TIMESTAMP / datetime('now') 存的是 UTC
  assert.equal(formatAppTime(BEIJING, "2026-09-12 16:00:00"), "2026-09-13 00:00:00");
  assert.equal(formatAppTime(BEIJING, "2026-09-12 16:00:00", { seconds: false }), "2026-09-13 00:00");
  // 还没跨天的那一分钟
  assert.equal(formatAppTime(BEIJING, "2026-09-12 15:59:59"), "2026-09-12 23:59:59");
  assert.equal(formatAppTime(BEIJING, "2026-09-12 00:30:00"), "2026-09-12 08:30:00");
});

test("formatAppTime：ISO 字符串、秒级与毫秒级时间戳都能换算", () => {
  assert.equal(formatAppTime(BEIJING, "2026-09-12T16:00:00.000Z"), "2026-09-13 00:00:00");
  assert.equal(formatAppTime(BEIJING, Date.UTC(2026, 8, 12, 16, 0, 0) / 1000), "2026-09-13 00:00:00");
  assert.equal(formatAppTime(BEIJING, Date.UTC(2026, 8, 12, 16, 0, 0)), "2026-09-13 00:00:00");
});

test("formatAppTime：时区可配置，缺省与空白值都回退 Asia/Shanghai", () => {
  assert.equal(getAppTimeZone({}), "Asia/Shanghai");
  assert.equal(getAppTimeZone({ APP_TIMEZONE: "   " }), "Asia/Shanghai");
  // 换成 UTC 时不加偏移，验证换算确实跟着配置走
  assert.equal(formatAppTime({ APP_TIMEZONE: "UTC" }, "2026-09-12 16:00:00"), "2026-09-12 16:00:00");
});

test("formatAppTime：解析不了原样返回，空值返回空串（不能让界面变成空白）", () => {
  assert.equal(formatAppTime(BEIJING, ""), "");
  assert.equal(formatAppTime(BEIJING, null), "");
  assert.equal(formatAppTime(BEIJING, undefined), "");
  assert.equal(formatAppTime(BEIJING, "不是时间"), "不是时间");
});

test("nowAppTime 与 getDateKey 用同一个时区（否则「今天」会差 8 小时）", () => {
  const now = nowAppTime(BEIJING);
  assert.match(now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(now.slice(0, 10), getDateKey(BEIJING));
});
