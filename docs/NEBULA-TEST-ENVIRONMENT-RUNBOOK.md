# NEBULA 隔离测试后台环境运行手册

## 0. 无银行卡的本地 Worker + D1/R2 模拟（当前优先路径）

本节不创建 Cloudflare 远程资源、不需要银行卡、不需要 Cloudflare 登录，也不部署 Worker。Wrangler 的本地开发由 Miniflare/workerd 提供本地 D1 与 R2 绑定；本地状态默认保存在 `.wrangler/state`，不会写入 Cloudflare 云端资源。仓库中的 `wrangler.local.example.toml` 是独立配置，严禁添加 `remote = true`。

首次运行（需要本机安装 Node.js 22+）：

```bash
npx wrangler@latest --version
npx wrangler@latest d1 migrations apply nebula-private-local --local --config wrangler.local.example.toml
npx wrangler@latest dev --local --config wrangler.local.example.toml --ip 127.0.0.1 --port 8787
```

Wrangler 首次启动会建立本地绑定；如当前 Wrangler 版本要求先初始化绑定，请升级到支持本地自动资源初始化的 Wrangler 版本后再运行。D1 migration 命令只使用 `--local`，不得去掉。启动后访问 `http://127.0.0.1:8787`，本地 D1/R2 数据留在项目的 `.wrangler/state`。停止服务后可再次启动并继续使用本地数据；需要完全重置时，先停止 Wrangler，再删除 `.wrangler/state`。

本地模式可验证 Worker 启动、绑定注入、D1 migration 与本地 R2 对象操作；它不能替代真实 Cloudflare D1/R2 的权限、网络、并发、Cron 调度和故障恢复验收，也不能证明 Clerk 测试实例/JWT真实配置有效。不得把本地通过写成云端验收通过。

若本地启动提示缺少认证变量，不要填入生产 issuer、生产 token 或生产 API key；先使用专用测试身份配置。没有完成身份配置前，只能验收本地 Worker 启动与绑定，不进行受保护的双账户 API 验收。

> **状态：准备就绪，尚未创建资源或部署。** 本文只提供隔离测试环境的操作步骤。任何创建 D1/R2、应用远程 migration、写入 Worker secrets 或部署 Worker 的操作，都必须在用户明确授权后执行。严禁将测试配置指向正式资源。

## 1. 隔离原则

- 使用专用 Cloudflare 测试账户优先；若必须共用账户，D1、R2、Worker 必须使用独立的测试名称。
- 测试 Worker 名称固定为 `nebula-private-test`，不得复用现有 `nebula-deepseek-bridge`。
- D1 数据库名称使用 `nebula-private-test`；R2 bucket 使用唯一名称，例如 `nebula-private-test-<随机后缀>`。
- 只使用 Clerk Development/Test 实例和专门的测试用户，不使用生产用户、生产 issuer 或生产 API audience。
- 不导入私人讲义或真实用户文件；先用无敏感内容的测试文件。
- 不创建自定义生产域名，不修改正式 Worker、正式 D1、正式 R2 或正式 Pages 入口。
- 现有 `wrangler.toml` 的 rate-limit namespace ID 尚未在目标 Cloudflare 账户核实，因此测试配置不复制该 ID，也不绑定未知 namespace。

## 2. 创建资源（需用户授权后执行）

在确认当前 Wrangler 登录的是目标测试账户后，执行：

```bash
npx wrangler whoami
TEST_R2_BUCKET="nebula-private-test-unique-suffix"
npx wrangler d1 create nebula-private-test
npx wrangler r2 bucket create "$TEST_R2_BUCKET"
```

记录 D1 返回的 database ID 和 R2 bucket 的唯一名称。不要把 API token、secret 或任何认证凭据写入仓库、聊天记录或提交内容。

## 3. 准备本地测试配置

```bash
cp wrangler.test.example.toml wrangler.test.toml
```

只在本地的 `wrangler.test.toml` 中替换：

- `REPLACE_WITH_CLERK_TEST_ISSUER`
- `REPLACE_WITH_NEBULA_TEST_API_AUDIENCE`
- `REPLACE_WITH_CLERK_TEST_JWKS_URL`
- `REPLACE_WITH_TEST_APP_ORIGIN`
- `REPLACE_WITH_TEST_D1_DATABASE_ID`
- `REPLACE_WITH_UNIQUE_TEST_R2_BUCKET_NAME`

Issuer、JWKS URL、Audience 和 Authorized Parties 必须来自实际 Clerk 测试实例与测试应用配置，不能猜测或照搬生产值。不要将填好真实资源 ID 的本地配置提交到 Git。

## 4. 配置 Worker secrets（需用户授权后执行）

`NEBULA_OWNER_NAMESPACE_SECRET` 必须使用安全随机生成的至少 32 字符值。只通过 Wrangler secret 命令写入，不把 secret 明文放进 TOML：

```bash
npx wrangler secret put NEBULA_OWNER_NAMESPACE_SECRET --config wrangler.test.toml
```

如果要验证 DeepSeek 聊天代理，再单独设置：

```bash
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.test.toml
```

文件同步与对象存储验收本身不需要把模型 API key 暴露给浏览器。Clerk JWT 模式不使用旧的共享 `NEBULA_SYNC_TOKEN` 作为用户身份凭据。

## 5. 应用 migration（需用户授权后执行）

确认配置中的 database ID 与测试 D1 完全匹配后：

```bash
npx wrangler d1 migrations apply nebula-private-test --remote --config wrangler.test.toml
npx wrangler d1 migrations list nebula-private-test --remote --config wrangler.test.toml
```

应按顺序应用：

1. `0001_owner_scoped_records.sql`
2. `0002_sync_consent_ledger.sql`
3. `0003_owner_scoped_objects.sql`
4. `0004_r2_upload_cleanup_intents.sql`

任何 migration 失败都应停止部署，保留错误输出并先修复；不要尝试在正式数据库上补跑。

## 6. 部署测试 Worker（需用户授权后执行）

只有在以下条件全部满足后才可部署：

- [ ] `wrangler whoami` 确认目标是测试账户
- [ ] D1 database ID 是刚创建的测试数据库
- [ ] R2 bucket 是专用测试 bucket
- [ ] 四份 migration 已在测试 D1 成功应用
- [ ] Clerk 测试 issuer/audience/JWKS/authorized parties 已真实核验
- [ ] `NEBULA_OWNER_NAMESPACE_SECRET` 已写入 Worker secrets
- [ ] 没有把生产 API key、用户数据或生产资源 ID 放入测试环境

部署命令：

```bash
npx wrangler deploy --config wrangler.test.toml
```

此命令不会由本手册自动执行。部署后确认 Worker 名称为 `nebula-private-test`，并检查 Cron 仅属于该测试 Worker。

## 7. 最小验收矩阵

| 验收项 | 预期结果 |
|---|---|
| Clerk 测试用户 A 登录 | JWT issuer、audience、JWKS 与 authorized party 验证通过 |
| Clerk 测试用户 B 登录 | 获得不同服务端 owner ID |
| A 开启 graph 同步授权 | A 可创建、读取、列出和删除自己的记录 |
| B 访问 A 的记录 | 不可读取、不可列出、不可修改 |
| A 撤销 graph 授权 | 后续读写失败关闭；删除本人云端副本仍可用 |
| A 上传大于 1 MiB 且不超过 10 MiB 文件 | 成功 |
| A 上传超过 10 MiB 文件 | 拒绝，且不留下可访问的孤儿对象 |
| cleanup intent 与 active metadata 交错 | 不得删除已提交对象 |
| 两个 scheduler 同时处理同一 intent | 仅一个成功认领 |
| R2 delete 成功、D1 intent 删除失败 | 后续可幂等恢复 |
| 15 分钟 Cron | 仅在测试 Worker 上运行，批次最多 50 条 |
| 私人文件跨账户访问 | B 无法访问 A 的对象 key 或内容 |

所有测试使用无敏感内容和专门测试账户。每项都保存可核实的请求结果、D1 记录状态与 Worker 日志摘要；日志不得包含文件正文、JWT、secret 或原始敏感 object key。

## 8. 回滚与销毁

测试失败时先停止测试 Worker 的部署/触发，再确认没有待处理任务。只有在用户明确授权后，才执行资源删除：

```bash
npx wrangler delete --name nebula-private-test
npx wrangler r2 bucket delete "$TEST_R2_BUCKET"
npx wrangler d1 delete nebula-private-test
```

销毁前导出并检查测试证据；不得对任何正式资源执行以上命令。若 Worker 已部署且 Cron 运行，先确认定时任务已停止，再删除 D1/R2。

## 9. 当前阻塞与责任边界

- Cloudflare 测试账户登录与资源创建：需要用户授权。
- Clerk 测试实例与应用域名：需要用户创建/授权，或提供非敏感的公开配置值。
- Wrangler secrets：由用户在目标账户中安全写入；不要在聊天中发送 secret。
- migration、部署和真实 E2E：仅在上述资源与授权齐备后执行。
- 在真实测试环境完成双账户、文件隔离、故障恢复与 Cron 验收前，P12/P13 均不得标记完成。
