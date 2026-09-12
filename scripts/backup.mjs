#!/usr/bin/env node
// ==========================================
// 💾 D1 数据备份脚本
// 用法：
//   npm run backup            # 导出线上（--remote）数据库
//   npm run backup:local      # 导出本地 wrangler dev 数据库（--local）
//   node scripts/backup.mjs --db tgbot-db --config wrangler.production.toml
// ==========================================

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

function readFlag(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const dbName = readFlag("--db", "tgbot-db");
const isLocal = argv.includes("--local");

// 优先使用带真实 database_id 的生产配置
const defaultConfig = existsSync("wrangler.production.toml")
  ? "wrangler.production.toml"
  : "wrangler.toml";
const configFile = readFlag("--config", defaultConfig);

const outDir = path.resolve(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(outDir, `${dbName}-${isLocal ? "local" : "remote"}-${stamp}.sql`);

const args = [
  "wrangler",
  "d1",
  "export",
  dbName,
  isLocal ? "--local" : "--remote",
  "--output",
  outFile,
  "--config",
  configFile
];

console.log(`💾 正在导出 D1 数据库「${dbName}」(${isLocal ? "本地" : "线上"})...`);
console.log(`   配置文件: ${configFile}`);
console.log(`   输出文件: ${outFile}`);

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.status === 0) {
  console.log(`\n✅ 备份完成: ${outFile}`);
  console.log("♻️  恢复方式: npx wrangler d1 execute " + dbName + " --remote --file=" + outFile);
} else {
  console.error(`\n❌ 备份失败（退出码 ${result.status ?? "unknown"}）`);
  console.error("   请确认已执行 npx wrangler login，且配置文件中存在该数据库绑定。");
  process.exit(result.status ?? 1);
}
