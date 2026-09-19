#!/usr/bin/env node
// ==========================================
// 🕰️ D1 Time Travel：查看可恢复的时间点
//
// D1 自带约 30 天的时间点恢复能力，适合「刚写错数据，想退回几分钟前」。
// 它和 `npm run backup` 导出的 SQL 快照是**互补**的：
//   • Time Travel：快、粒度细，但窗口有限，且**救不了账号级事故**（库被删、账号出问题）
//   • SQL 快照：可异地留存，能扛账号级事故，但只能恢复到最后一次导出的状态
//
// 用法：
//   npm run backup:info
//   node scripts/backup-info.mjs --db tgbot-db --config wrangler.production.toml
// ==========================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const argv = process.argv.slice(2);

/** 读取 `--flag value` 形式的参数，缺省时返回 fallback */
function readFlag(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const dbName = readFlag("--db", "tgbot-db");
const configFile = readFlag(
  "--config",
  existsSync("wrangler.production.toml") ? "wrangler.production.toml" : "wrangler.toml"
);

console.log(`🕰️ 查询 D1「${dbName}」的 Time Travel 时间点...`);
console.log(`   配置文件: ${configFile}\n`);

const res = spawnSync(
  "npx",
  ["wrangler", "d1", "time-travel", "info", dbName, "--config", configFile],
  { stdio: "inherit", shell: process.platform === "win32" }
);

if (res.status !== 0) {
  console.error(`\n❌ 查询失败（退出码 ${res.status ?? "unknown"}）`);
  console.error("   常见原因：尚未登录（npx wrangler login），或该数据库不是远程库。");
  console.error("   本地开发库不需要 Time Travel，直接 `npm run backup:local` 导出即可。");
  process.exit(res.status ?? 1);
}

console.log("\n💡 恢复到某个时间点：");
console.log(`   npx wrangler d1 time-travel restore ${dbName} --config ${configFile} --bookmark=<上面那个 bookmark>`);
console.log(`   npx wrangler d1 time-travel restore ${dbName} --config ${configFile} --timestamp=2026-09-19T10:00:00Z`);
console.log(
  "\n⚠️  恢复是**整体回退**：库会回到那个时刻，之后的写入全部消失。\n" +
  "    动手前先跑一次 `npm run backup` 留一份当前快照，别把「救火」变成「二次事故」。"
);
