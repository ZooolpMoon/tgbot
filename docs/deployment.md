# 🚢 部署与运维

[返回首页](../README.md) · [文档索引](README.md)

## 部署

```bash
npm run deploy         # 使用 wrangler.toml
npm run deploy:prod    # 使用 wrangler.production.toml（推荐把生产配置单独放）
```

部署是本地行为，仓库里不带任何 CI/CD 配置。首次部署后记得设置 Webhook（见 [README 快速开始](../README.md#6-设置-webhook)）。

## 日志与回滚

```bash
npm run tail                       # 实时日志（HTTP 请求、定时任务输出、异常堆栈）
npx wrangler deployments list      # 查看历史部署
npx wrangler rollback              # 回滚到上一个版本
```

日志里能看到的几类信息：

| 前缀 | 含义 |
|------|------|
| `[INFO]` | 定时任务结果（清理条数、索引重建、日报发送状态） |
| `[WARN]` | 可恢复的告警（模型回退、Telegram 限流重试、命令菜单同步失败） |
| `[ERROR]` | 异常（会写明组件，例如「知识库向量化失败」「发送处置公告失败」） |

## 数据备份

```bash
npm run backup          # 导出线上 D1 → backups/<db>-remote-<时间>.sql
npm run backup:local    # 导出本地开发库
```

恢复：

```bash
npx wrangler d1 execute your-db-name --remote --file=backups/xxx.sql
```

`backups/` 已在 `.gitignore` 中，不会进仓库。建议定期导出，或用 `cron` / 计划任务定时跑 `npm run backup`。

## 配置备份（可选）

`wrangler.production.toml` 与 `.dev.vars` 含 Token，不能进公开仓库。可以把它们备份到**自己的私有仓库**：

```bash
echo "your-name/your-private-repo" > .config-backup
npm run backup:config
```

脚本行为：

1. 先通过 GitHub API 确认目标仓库**确实是私有的**，不是就中止（退出码 4）
2. 逐文件比对内容，没变化不产生多余提交
3. 走 `api.github.com` 的 Contents API，因此 `github.com:443` 被墙时也能用
4. 凭据来源：环境变量 `GITHUB_TOKEN` / `GH_TOKEN`，否则复用本机 Git 凭据管理器

目标仓库也可以通过环境变量指定：`CONFIG_BACKUP_REPO=owner/repo`（优先级高于 `.config-backup`）。

## 定时任务

Cron 表达式在 `wrangler.toml` 的 `[triggers]`，默认：

```toml
[triggers]
crons = ["0 16 * * *"]      # UTC 16:00 = 北京时间 00:00
```

每次执行做四件事：

1. **清理过期数据**

   | 对象 | 规则 |
   |------|------|
   | 管理员解锁会话 | 到期即删 |
   | 群发草稿 | 7 天前 |
   | 下单备注 / 商品添加 / 商品编辑 / 知识库 / 群规编辑会话 | 1 天前（业务侧本来就有 30 分钟有效期，这里是兜底） |
   | 过期兑换码 | 自动停用 |
   | 未确认的处置记录 | 1 天前 |
   | 已处理完的申诉 | 30 天前 |

2. **处置到期处理**：把到期的限时禁言 / 封禁标记为 `expired`，在群里公告「处置已到期」，并私聊当事人「限制已解除」
3. **知识库索引维护**：给「没有向量」或「向量模型与当前不一致」的分块补建（每次最多 20 块，分批完成）
4. **推送每日概况**：给管理员发送昨日活跃场景、消息量、签到人数、兑换码使用、封禁数、待处理订单与清理条数；有待处理订单时附带处理按钮

> Cron 始终按 **UTC** 解析；`APP_TIMEZONE` 只影响业务里的「今天」怎么算。

## 资源与配额建议

| 关注点 | 建议 |
|--------|------|
| Workers AI 额度 | AI 对话每次请求调用一次模型；知识库检索再调用一次向量模型。免费额度用完时对话会自动回退到备用模型，全部失败会退分并提示 |
| D1 读写 | 每条消息大约 3~8 次查询；知识库检索会把该作用域的候选向量读进内存，所以单库上限设 400 块 |
| CPU 时间 | 群发、索引重建、处置到期通知都做了分批与时间预算，避免单次执行超限 |
| 群发 | 单次最多 10000 人、每批 50 人、单次时间预算 20 秒，超出会提示「继续发送」 |

## 变更前的检查清单

```bash
npm run check && npm test     # 1. 自检 + 测试全绿
npm run deploy:prod           # 2. 部署
npm run tail                  # 3. 观察日志确认无异常
```

如果改了数据库结构，注意：

- `SCHEMA_VERSION` 是否已 +1（否则冷启动会跳过建表）
- 迁移语句是否幂等（重复执行不能报错、不能清掉管理员的数据）
- 部署后第一次请求会触发建表 + 迁移；如需提前在生产库上验证 SQL，可以：

  ```bash
  npx wrangler d1 execute your-db-name --remote --file=your-schema.sql
  ```

  建议**只包含 `CREATE TABLE IF NOT EXISTS` 与新增字段的 `ALTER TABLE`**，这样重复执行也安全。
