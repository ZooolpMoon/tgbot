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

## 数据备份与恢复

数据和配置都只有一份，**两类事故要分开防**：

| 方式 | 命令 | 能救什么 | 救不了什么 |
|------|------|----------|-----------|
| 🕰️ D1 Time Travel | `npm run backup:info` | 刚写错数据，想退回几分钟前（窗口约 30 天） | 库被删、账号级事故 |
| 💾 SQL 快照 | `npm run backup` | 库被删、账号出问题（可以异地留存） | 只能回到最后一次导出的状态 |

**两者互补，别只依赖其中一个。**

### 💾 SQL 快照（建议定期跑）

```bash
npm run backup          # 导出线上 D1 → backups/<db>-remote-<时间>.sql
npm run backup:local    # 导出本地开发库
```

- 默认**只保留最近 10 份**同类快照（`node scripts/backup.mjs --keep 20` 可调），不会把 `backups/` 撑爆
- `backups/` 已在 `.gitignore` 中，不要提交（里面是用户数据）
- 建议挂一个本机计划任务（`cron` / 任务计划程序）每天跑一次 —— 部署是本地行为，备份也放在本地最省事

恢复（把快照重新执行一遍）：

```bash
npx wrangler d1 execute your-db-name --remote --file=backups/xxx.sql
```

> ⚠️ 这是「把 SQL 再跑一遍」，**不是**清库重建。往一个已有数据的库上灌会撞主键冲突或写出重复行。
> 想整库回滚到某个时刻，用下面的 Time Travel。

### 🕰️ Time Travel（D1 自带的时间点恢复）

```bash
npm run backup:info     # 看当前可恢复的 bookmark（以及它给出的 restore 命令）
npx wrangler d1 time-travel restore <db> --config wrangler.production.toml --bookmark=<bookmark>
# 也可以按时间恢复：--timestamp=2026-09-19T10:00:00Z
```

- 窗口约 **30 天**，粒度细，适合「刚批量删错了东西」
- ⚠️ 恢复是**整体回退**：库会回到那个时刻，之后的写入全部消失。动手前先 `npm run backup` 留一份当前快照，别把救火变成二次事故

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

Cron 表达式在 `wrangler.toml` 的 `[triggers]`，默认两条：

```toml
[triggers]
crons = [
  "0 16 * * *",     # UTC 16:00 = 北京时间 00:00：清理 + 索引维护 + 推日报
  "*/2 * * * *"     # 每 2 分钟：长延时自动删除 + webhook 自愈巡检
]
```

> ⚠️ 少了 `*/2 * * * *` 这条，长延时自动删除、过期会话清理、知识库补索引、到期处置通知都会退化成「一天只跑一次」，长延时删除最多延迟约 24 小时。

每次执行做五件事：

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
4. **Webhook 自愈巡检**（v3.4.0）：查一次 Telegram 侧的 webhook 地址，空了就用期望地址补回并私聊告警（isolate 内 10 分钟最多查一次；详见下节）
5. **推送每日概况**：给管理员发送昨日活跃场景、消息量、签到人数、兑换码使用、封禁数、待处理订单与清理条数；有待处理订单时附带处理按钮

> Cron 始终按 **UTC** 解析；`APP_TIMEZONE` 只影响业务里的「今天」怎么算。
> 第 5 步只由 `0 16 * * *` 那条负责，每 2 分钟的 cron 不做推送（否则日报会每 2 分钟弹一次）。

## 机器人「完全没反应」怎么排查

最坑的一种故障是**无声的**：Worker 正常、Token 正常、日志里一条错都没有，但发消息就是没反应。按这个顺序查：

```bash
# 1. Token 还有效吗（返回 ok:true 就说明有效）
curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"

# 2. Worker 还活着吗（浏览器打开应显示「已成功部署！」）
curl "https://your-worker.<subdomain>.workers.dev/"

# 3. ⭐ webhook 地址还在吗 —— 多数「没反应」死在这一步
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

第 3 步返回的 `url` 如果是**空串**，就是地址被清掉了 —— 更新无处投递，Worker 再正常也没用。两个常见诱因：

- **在 BotFather 撤销 / 更换过 Token**（实测：换 token 后地址会被清空）
- 手动 `deleteWebhook` 过，或换了域名 / Worker 名称

修复：

```bash
curl -F "url=https://your-worker.<subdomain>.workers.dev/" \
     -F "secret_token=<与 WEBHOOK_SECRET 相同的随机串>" \
     "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook"
```

**顺序很重要**：先 `setWebhook`（带新的 `secret_token`）再 `npm run deploy:prod`。反过来的话，配了 `WEBHOOK_SECRET` 的新 Worker 会拒收所有更新（401），看起来还是死的。

### 自愈巡检（v3.4.0）

配好 `WEBHOOK_URL` 之后，上面第 3 步的问题会被定时任务自动发现并修好：

| Telegram 侧状态 | 巡检行为 |
|------------------|----------|
| `url` 为空 | 用 `WEBHOOK_URL`（没填则用「上一次通过 secret 校验的请求地址」）自动 `setWebhook`，并私聊管理员 |
| 有 `last_error_message` | 私聊告警；**内容变了才提醒**，不会每轮刷屏 |
| `url` 非空但与期望值不同 | **保持不动**（可能是有意配的自定义域名 / 反代） |
| 不知道该恢复成什么地址 | 什么都不做，只写日志（模板默认状态） |

实现见 `src/services/webhook.js`，一次巡检最多 4 次查询、10 分钟一次；想彻底关掉就让 `WEBHOOK_SECRET` 与 `WEBHOOK_URL` 都留空。


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
