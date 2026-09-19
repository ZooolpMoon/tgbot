#!/usr/bin/env node
// ==========================================
// 💾 D1 数据备份脚本
// 用法：
//   npm run backup            # 导出线上（--remote）数据库
//   npm run backup:local      # 导出本地 wrangler dev 数据库（--local）
//   node scripts/backup.mjs --db tgbot-db --config wrangler.production.toml --keep 20
//
// 关于「备份到底够不够」：
//   • 这个脚本导出的是**独立 SQL 快照**，能扛住「库被误删 / 账号出问题」这类事故；
//   • D1 另外自带 **Time Travel**（约 30 天的时间点恢复，见 `npm run backup:info`），
//     适合「刚写错数据，想退回几分钟前」这种场景；
//   • 两者互补，别只依赖其中一个。建议定期跑这个脚本（本地计划任务即可）。
// ==========================================

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

/** 读取 `--flag value` 形式的参数，缺省时返回 fallback */
function readFlag(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const dbName = readFlag("--db", "tgbot-db");
const isLocal = argv.includes("--local");
/** 同一目标最多保留几份快照（时间戳文件名可字典序排序，越早越小） */
const keepCount = Math.max(1, Number.parseInt(readFlag("--keep", "10"), 10) || 10);

// 优先使用带真实 database_id 的生产配置
const defaultConfig = existsSync("wrangler.production.toml")
  ? "wrangler.production.toml"
  : "wrangler.toml";
const configFile = readFlag("--config", defaultConfig);

const outDir = path.resolve(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const prefix = `${dbName}-${isLocal ? "local" : "remote"}-`;
const outFile = path.join(outDir, `${prefix}${stamp}.sql`);

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

/** 只保留最近 keepCount 份同类快照，避免 backups/ 无限膨胀 */
function pruneOldBackups() {
  let files;
  try {
    files = readdirSync(outDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".sql"))
      .sort();
  } catch {
    return;
  }
  const stale = files.slice(0, Math.max(0, files.length - keepCount));
  for (const name of stale) {
    try {
      unlinkSync(path.join(outDir, name));
      console.log(`🧹 清理旧备份: ${name}`);
    } catch {
      /* 删不掉就算了，不影响本次备份结果 */
    }
  }
}

/** 新快照有多大（让人对备份是否可用有个直观判断） */
function sizeOf(file) {
  try {
    const kb = statSync(file).size / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`;
  } catch {
    return "未知大小";
  }
}

if (result.status === 0) {
  console.log(`\n✅ 备份完成: ${outFile}（${sizeOf(outFile)}）`);
  pruneOldBackups();
  console.log("♻️  恢复到同一个库: npx wrangler d1 execute " + dbName + " --remote --file=" + outFile);
  console.log("🕰️  只想退回几分钟前: npm run backup:info 拿到 bookmark 再 restore（见 docs/deployment.md）");
} else {
  console.error(`\n❌ 备份失败（退出码 ${result.status ?? "unknown"}）`);
  console.error("   请确认已执行 npx wrangler login，且配置文件中存在该数据库绑定。");
  process.exit(result.status ?? 1);
}
