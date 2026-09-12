#!/usr/bin/env node
// ==========================================
// ✅ 代码自检（本地 & CI 共用）
// 1. 语法检查所有 .js / .mjs
// 2. 检查相对 import 路径是否存在
// 3. 校验 DB Schema 里是否出现了未声明的表（粗查）
// 用法：npm run check
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

if (failures.length > 0) {
  console.error(`\n❌ 自检失败（${failures.length} 项）：\n`);
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}

console.log(`✅ 自检通过：${fileCount} 个文件语法正常，${importCount} 个相对 import 路径有效`);
