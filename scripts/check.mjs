#!/usr/bin/env node
// ==========================================
// ✅ 代码自检（本地 & CI 共用）
// 1. 语法检查所有 .js / .mjs
// 2. 检查相对 import 路径是否存在
// 3. 文档一致性：版本号与测试用例数不许漂移
// 用法：npm run check
//
// 说明：这里只做「机器能确定」的三件事。表名与 SCHEMA_SQL 是否一致、
// 命令注册表的 capability 与回调路由是否对得上，目前靠 `npm test` 兜
// （`test/schema.test.mjs`、`test/admins.test.mjs`），别在这个脚本里写半成品校验。
// ==========================================

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanDirs = ["src", "scripts", "test", "test-helpers"];
const codeExt = /\.(mjs|js)$/;

const failures = [];
let fileCount = 0;
let importCount = 0;

/** 递归收集目录下所有文件（相对路径） */
function walk(dir) {
  const abs = path.join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

const files = scanDirs.flatMap(walk).filter((f) => codeExt.test(f));

for (const relFile of files) {
  const absFile = path.join(repoRoot, relFile);
  fileCount++;

  // --- 语法检查 ---
  const res = spawnSync(process.execPath, ["--check", absFile], { encoding: "utf8" });
  if (res.status !== 0) {
    failures.push(`语法错误 ${relFile}\n${(res.stderr || "").trim()}`);
    continue;
  }

  // --- import 路径检查 ---
  const src = readFileSync(absFile, "utf8");
  const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const match of src.matchAll(importRe)) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    importCount++;
    const target = path.resolve(path.dirname(absFile), spec);
    if (!existsSync(target)) {
      failures.push(`import 目标不存在 ${relFile} → ${spec}`);
    }
  }
}

// ==========================================
// 📄 文档一致性（v3.9.0）
//
// 版本号与测试用例数是**手工**维护的，也正是历史上反复漂移的两处
// （v3.7.0 修过「测试数 260 写成 365」，v3.8.0 之后 README 又停在 v3.2.2）。
// 机器能算出来的东西就别靠自觉：这里直接对账。
// ==========================================
function readText(rel) {
  const abs = path.join(repoRoot, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

let version = null;
let testCount = 0;
try {
  version = JSON.parse(readText("package.json") || "{}").version || null;
} catch (e) {
  failures.push(`package.json 解析失败：${e?.message || e}`);
}

// 实际用例数 = test/*.test.mjs 里行首的 `test(` 声明数，
// 与 `node --test` 报告的 `# tests` 一致（子测试缩进写法不计入）。
for (const relFile of walk("test").filter((f) => /\.test\.mjs$/.test(f))) {
  const text = readText(relFile) || "";
  testCount += (text.match(/^test\(/gm) || []).length;
}

if (version) {
  // README 与 CHANGELOG 顶部都有一句「当前版本 **vX.Y.Z**」
  for (const relFile of ["README.md", "CHANGELOG.md"]) {
    const text = readText(relFile);
    if (text === null) continue;
    const found = /当前版本\s*\*\*(v[\d.]+)\*\*/.exec(text);
    if (!found) {
      failures.push(`文档缺少版本号声明：${relFile}（应含「当前版本 **v${version}**」）`);
    } else if (found[1] !== `v${version}`) {
      failures.push(`版本号不一致：${relFile} 写的是 ${found[1]}，package.json 是 v${version}`);
    }
  }
}

if (testCount > 0) {
  for (const relFile of ["README.md", "docs/development.md"]) {
    const text = readText(relFile);
    if (text === null) continue;
    const found = /(\d+)\s*个测试用例/.exec(text);
    if (!found) {
      failures.push(`文档缺少测试数声明：${relFile}（应含「${testCount} 个测试用例」）`);
    } else if (Number(found[1]) !== testCount) {
      failures.push(`测试数不一致：${relFile} 写的是 ${found[1]}，实际是 ${testCount}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n❌ 自检失败（${failures.length} 项）：\n`);
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}

console.log(
  `✅ 自检通过：${fileCount} 个文件语法正常，${importCount} 个相对 import 路径有效` +
  `，文档一致（v${version || "?"} · ${testCount} 个用例）`
);
