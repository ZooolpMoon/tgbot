#!/usr/bin/env node
// ==========================================
// 🔐 生产配置备份（`npm run backup:config`）
//
// 把本地的 wrangler.production.toml 与 .dev.vars 备份到**私有** GitHub 仓库。
// 走 GitHub Contents API，因此 github.com 的 git 端口被墙时也能正常备份。
//
// 凭据来源（按优先级）：
//   1. 环境变量 GITHUB_TOKEN / GH_TOKEN
//   2. 本机 Git 凭据管理器（git credential fill，与 git push 用的是同一份）
//
// 目标仓库（二选一，避免把私有仓库名写进公开代码）：
//   1. 环境变量 CONFIG_BACKUP_REPO=owner/repo
//   2. 项目根目录的未跟踪文件 .config-backup（内容就一行 owner/repo）
// ==========================================

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["wrangler.production.toml", ".dev.vars"];

// ---------- 解析目标仓库 ----------
/** 目标仓库优先取环境变量，其次取未跟踪文件 .config-backup（一行 owner/repo） */
function resolveTargetRepo() {
  if (process.env.CONFIG_BACKUP_REPO) return process.env.CONFIG_BACKUP_REPO.trim();
  const localConfig = path.join(repoRoot, ".config-backup");
  if (existsSync(localConfig)) {
    const value = readFileSync(localConfig, "utf8").split("\n")[0].trim();
    if (value) return value;
  }
  return "";
}

const TARGET_REPO = resolveTargetRepo();
const BRANCH = process.env.CONFIG_BACKUP_BRANCH || "main";

if (!TARGET_REPO) {
  console.error(
    "❌ 未指定配置备份仓库。\n" +
    "   任选一种方式：\n" +
    "   1) 在项目根目录创建 .config-backup 文件，内容写一行 owner/repo；\n" +
    "   2) 设置环境变量 CONFIG_BACKUP_REPO=owner/repo。"
  );
  process.exit(2);
}

// ---------- 找 git ----------
/** 找一个可用的 git 可执行文件（PATH 里没有时尝试 Windows 默认安装路径） */
function findGit() {
  const candidates = [
    process.env.GIT_BIN,
    "git",
    "C:/Program Files/Git/cmd/git.exe",
    "C:/Program Files (x86)/Git/cmd/git.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/Git/cmd/git.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

// ---------- 取 Token ----------
/** 从环境变量取 GitHub Token */
function tokenFromEnv() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
}

/** 通过 git credential fill 读取系统凭据管理器里的 Token */
function tokenFromCredentialManager() {
  const git = findGit();
  if (!git) return "";
  try {
    const out = execFileSync(git, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    const line = out.split("\n").find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length).trim() : "";
  } catch {
    return "";
  }
}

const token = tokenFromEnv() || tokenFromCredentialManager();
if (!token) {
  console.error(
    "❌ 找不到 GitHub 凭据。\n" +
    "   请二选一：\n" +
    "   1) 先执行一次 git push（凭据会存进系统凭据管理器），再运行本命令；\n" +
    "   2) 设置环境变量 GITHUB_TOKEN=<你的 PAT>。"
  );
  process.exit(2);
}

/** 调用 GitHub REST API，统一带上鉴权头并返回 { ok, status, json, text } */
async function api(pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tgbot-config-backup",
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ---------- 安全检查：目标仓库必须是私有的 ----------
const repoInfo = await api(`/repos/${TARGET_REPO}`);
if (!repoInfo.ok) {
  console.error(`❌ 无法访问备份仓库 ${TARGET_REPO}（HTTP ${repoInfo.status}）：${repoInfo.json?.message || ""}`);
  process.exit(3);
}
if (repoInfo.json.private !== true) {
  console.error(
    `🛑 目标仓库 ${TARGET_REPO} 不是私有仓库，已中止。\n` +
    "   里面会包含 Bot Token，绝不能用公开仓库备份。"
  );
  process.exit(4);
}

// ---------- 逐个文件上传 ----------
const now = new Date().toISOString().replace("T", " ").slice(0, 19);
let uploaded = 0;

for (const file of FILES) {
  const abs = path.join(repoRoot, file);
  if (!existsSync(abs)) {
    console.log(`  ⏭️  ${file} 不存在，跳过`);
    continue;
  }
  const content = readFileSync(abs);

  const current = await api(`/repos/${TARGET_REPO}/contents/${encodeURIComponent(file)}?ref=${BRANCH}`);
  const sha = current.ok && current.json?.sha ? current.json.sha : undefined;

  // 内容没变就不产生多余提交
  if (sha && current.json?.content) {
    const remoteContent = Buffer.from(current.json.content, "base64");
    if (remoteContent.equals(content)) {
      console.log(`  ⏭️  ${file} 内容未变化，跳过`);
      continue;
    }
  }

  const body = {
    message: `backup: 更新 ${file}（${now}）`,
    content: content.toString("base64"),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  const put = await api(`/repos/${TARGET_REPO}/contents/${encodeURIComponent(file)}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });

  if (!put.ok) {
    console.error(`  ❌ ${file} 上传失败（HTTP ${put.status}）：${put.json?.message || put.text.slice(0, 200)}`);
    process.exit(5);
  }

  uploaded++;
  console.log(`  ✅ ${file}（${content.length} 字节）`);
}

console.log(
  uploaded > 0
    ? `\n🔐 已备份 ${uploaded} 个文件到私有仓库 https://github.com/${TARGET_REPO}`
    : `\n✅ 配置无变化，私有仓库 ${TARGET_REPO} 已是最新`
);
console.log("   恢复：克隆该仓库，把两个文件复制回项目根目录即可（详见其 README）。");
