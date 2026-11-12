# NEBULA 后台接入准备计划

状态：**前端保持 local-first；测试后台尚未接入；正式后台禁止接入。**

本计划基于 2026-11-10 对 `index.html`、`nebula-local.js`、`deepseek-worker.js`、`wrangler.toml` 与身份隔离契约的代码审计。它是执行清单，不代表 Cloudflare 资源已创建或任何服务已部署。

## 当前代码事实

- 知识图谱、原始参考文件、对话档案和提取内容由浏览器 IndexedDB 保存；LocalStorage 仅有兼容缓存及少量 UI/同步设置。
- 当前页面中的 DeepSeek 分享导入流程把 `NEBULA_SYNC_TOKEN` 放在用户输入框并由浏览器发起 Worker 请求；它是部署级共享令牌，不是用户登录凭据。
- 当前 Worker 的 `/share`、`/analyze`、`/research`、`/chat`、`/coach`、`/mnemonic` 路由使用共享令牌鉴权；没有真实用户 JWT 验证，也没有 D1/R2 owner-scoped 私有数据 API。
- 2026-11-10 后续安全加固：JWT 验证原型增加 JWKS 大小/超时、RSA 最低强度、重复 kid 拒绝、authorized party allowlist、iat/exp 生命周期限制；Worker 入站 body 1 MiB / 15 秒限制、上游 8 MiB / 20 秒限制与共享令牌常量时间比较。仍未接入真实身份。
- 当前没有可验证的云端账户身份、数据同步或私人讲义云存储实现。
- `wrangler.toml` 中的 Rate Limiter namespace 尚未确认；不得部署或声称线上限流生效。

## 已确认的产品决策：本地优先＋自主云同步（2026-11-10）

用户已明确选择 **B：本地优先＋自主开启云同步（Local-first + Opt-in Cloud Sync）**。这是后续认证、前端 adapter、存储和验收的强制产品约束：

- 未登录时，核心知识宇宙和本地资料仍可使用；登录不是使用本地功能的前提。
- 第三方身份认证只负责验证账户身份与签发/撤销身份令牌；不得把私人知识内容交给身份提供方存储。
- 登录成功、刷新令牌或重新打开应用均不得自动触发私人数据上传。
- IndexedDB 继续作为可独立工作的本地数据层；认证服务、网络、Worker 或云存储故障不得清空、覆盖或阻断本地资料。
- 云同步默认关闭。用户必须在清晰说明同步范围、数据去向和影响后主动开启；应允许按资料类别选择同步范围，并可暂停或关闭。
- 未获同步授权的数据不得上传到 NEBULA 云端；不得把 AI 请求、分享导入或身份验证隐式当作云同步授权。需要发送内容给 AI 服务时，必须单独说明本次发送的内容与目的。
- 同步关闭后，本地使用继续可用；云端副本的保留/删除应提供明确控制和确认，不得静默删除或静默继续同步。
- 端到端加密、密钥恢复及云端加密方案仍需单独设计和安全评审；在验证前不得宣称云端数据已实现端到端加密。

此决策已锁定为产品要求；**不代表前端同步开关、用户认证或云端存储已经实现**。

## 里程碑

### M0 — 前置选择与环境准备（未完成）

身份提供方比较记录见 [NEBULA 第三方身份服务选型评估](./NEBULA-AUTH-PROVIDER-EVALUATION.md)。当前 Clerk 为第一候选、Auth0 为备选，尚未最终选定或创建供应商账户。

- [x] 用户确认 Clerk 作为测试阶段首选身份提供方；实际测试实例、回调域名及账户生命周期仍待配置。
- [ ] 明确测试环境域名、回调地址、issuer、audience、JWKS URL。
- [ ] 确认独立 Cloudflare 测试环境及账号权限。
- [ ] 确认 Rate Limiter namespace 唯一性与 Wrangler CLI 版本。

### M1 — 真实身份认证（原型阶段；Worker 尚未接入）

- [x] 建立供应商无关 RS256/JWKS 验证原语，固定配置 issuer、audience、HTTPS JWKS URL。
- [x] 建立合成 RSA/JWKS 测试：签名、过期、错误 issuer/audience、空 subject、iat/exp 生命周期、未来 nbf、alg=none、恶意 jku、未知 kid、签名错误、密钥轮换及 JWKS 故障。
- [x] 建立基于服务端 namespace secret 的 HMAC-SHA-256 owner_id 派生原语。
- [ ] Worker 服务端验证真实 Clerk API access token；完成前现有共享令牌仍在用，不能称为用户身份认证。
- [ ] 固定测试环境 issuer、audience、JWKS URL，完成 Clerk 真实测试实例验证。
- [ ] 拒绝客户端 userId、ownerId、tenantId 作为身份依据，并将验证结果接入私有 API 授权层。

### M2 — 隔离存储与 API（未完成）

- [ ] 仅在独立测试环境创建 D1/R2。
- [ ] D1 每个私有读写删、关联、搜索、导出和后台任务均 owner-scoped。
- [ ] R2 对象 key 由服务端派生 owner 命名空间；下载/签名 URL 先校验归属。
- [ ] A/B 两个合成用户的跨用户访问、枚举、覆盖、删除、导出负向测试全部通过。
- [ ] 不把现有共享令牌接口升级包装成用户级数据 API。

### M3 — 前端适配与数据安全（未完成）

- [ ] 建立认证态与 API adapter；本地 IndexedDB 模式继续可独立运行。
- [ ] 云端同步必须显式启用，不能在登录后自动上传私人数据。
- [ ] 设计冲突解决、删除传播、离线队列和同步失败回退。
- [ ] 完成全量备份、恢复、迁移、回滚与撤销测试。
- [ ] 日志脱敏，不记录访问令牌、私人讲义正文或原始文件内容。

### M4 — 测试后台验收（未开始）

- [ ] 使用合成数据完成浏览器端到端测试。
- [ ] 验证登录、登出、撤销、A/B 隔离、文件上传/下载、搜索、备份恢复。
- [ ] 验证认证服务、JWKS、D1、R2 故障时 fail closed。
- [ ] 输出测试报告与回滚演练结果。
- [ ] 用户验收测试后台。

### M5 — 正式后台（禁止提前执行）

只有 M0–M4 全部通过、风险与回滚报告齐备、用户明确批准后，才评估正式资源配置与数据迁移。不得在批准前部署生产 Worker、创建/改动正式资源或上传私人资料。

## Clerk 测试阶段决策（2026-11-10）

用户已选择 A：Clerk 优先。供应商无关 Auth Adapter、显式同步授权测试、JWT/JWKS 验证原语和 HMAC owner_id 派生原型已建立，详见 [NEBULA Clerk 测试阶段实施边界](./NEBULA-CLERK-TEST-IMPLEMENTATION.md)。这不是 Clerk 账户已创建、Worker 已接入或测试后台可用的证明。

## 接入判定

- **现在：不可接测试后台**（身份提供方和独立测试资源尚未准备）。
- **现在：不可接正式后台**（真实 JWT、owner 隔离、备份恢复、E2E 均未完成）。
- **可以立即继续的工作：** provider-agnostic 的身份验证设计、测试夹具、隔离 API 契约、前端 adapter 设计；所有真实云资源操作保持关闭。

## 估时口径

在身份提供方和测试环境权限明确后，测试后台仍需多个独立交付与验收阶段；不能把代码提交或 CI 通过等同于可接入。实际工期取决于身份提供方账号配置、Cloudflare 测试资源权限及双用户 E2E 结果。本计划不承诺未经验证的上线日期。


## 2026-11-10 后续推进：Worker 身份中间件

- [x] 新增 nebula-worker-auth.js，统一处理 Worker 路由身份认证。
- [x] 保留共享令牌兼容模式，但其上下文明确标记为 shared-service，不生成 owner ID。
- [x] 增加可选 clerk-jwt 验证模式：固定 issuer/audience/JWKS、authorized party allowlist、服务端 HMAC owner 派生。
- [x] JWT 配置缺失、错误或验证服务不可用时 fail closed；JWT 模式不会回退到共享令牌。
- [x] /share 与受保护 AI/研究路由统一经过中间件；移除重复的路由级共享令牌判断。
- [x] 新增中间件测试和 Worker 真实 RSA/JWKS 合成验签集成测试。
- [ ] 真实 Clerk 测试实例及 session token claims 验证（尚未获授权创建第三方实例）。
- [ ] 通过 D1/R2 owner-scoped repository 层把认证上下文的 ownerId 强制用于每一条私有资源操作。
- [ ] 两个独立合成用户 A/B 的越权读写、搜索、导出、下载、备份/恢复负向测试。
- [ ] 真实浏览器 E2E、撤销窗口和线上运行时安全验证。

当前身份中间件尚未启用 Clerk 模式；未部署 Worker、未创建 Cloudflare 资源、未迁移数据。不能将身份上下文原型等同于完成多用户数据隔离。


## D1 owner-scoped repository prototype

- [x] 新增统一 owner-scoped D1 repository：GET/LIST/UPSERT/DELETE 全部绑定服务端 owner ID。
- [x] 新增 records schema migration：复合 owner 主键、owner/type/update 索引、JSON object 与 256 KiB payload 限制。
- [x] 新增模拟 D1 binding 契约测试：验证 owner 参数固定、客户端 owner_id 不能覆盖归属、分页与 payload 上限。
- [ ] 将 repository 接入 Worker 私有数据 API（仅 clerk-jwt 用户上下文允许，shared-service 永远拒绝）。
- [ ] 在真实隔离的 D1 测试数据库应用 migration，完成双用户 A/B 实际 SQL 越权测试。
- [ ] 增加 R2 owner 前缀与元数据绑定层，并完成跨用户下载/删除负向测试。

本阶段只有代码原型与模拟 binding 测试，尚未连接、创建或迁移真实 D1/R2 资源。

- D1 repository 增加显式同步授权门槛：未取得服务端确认的 enabled/category/confirmedAt 授权时拒绝所有云端记录操作；不得从客户端请求体直接构造 syncConsent。


## 2026-11-10 后续推进：服务端同步授权账本原型

- [x] 新增 `nebula-sync-consent.js`：以服务端验证身份派生的 owner ID 为唯一主键，读取/写入用户的同步类别与状态。
- [x] 新增 `migrations/0002_sync_consent_ledger.sql`：保存 categories、enabled/paused/revoked 状态、确认时间、更新时间和撤销时间。
- [x] 撤销采用保留记录的 tombstone，不自动删除云端数据；后续删除云端副本必须另设明确操作与确认。
- [x] 增加测试覆盖 owner 绑定、类别授权、暂停、撤销、无效类别和无效身份。
- [ ] 将账本接入 Worker 的认证用户专属授权/撤销 API；共享令牌上下文必须永久拒绝。
- [ ] 由 Worker 在每次 D1/R2 操作前读取此账本，并把服务端确认的授权状态交给 repository；不得信任请求体里的 ownerId 或 consent 状态。
- [ ] 把授权写入与云数据读写置于一致的撤销检查边界，并覆盖并发撤销/正在进行的上传。

当前仍是独立 repository + migration 原型；未接入 Worker 路由，未应用真实 D1 migration，未创建 Cloudflare 资源，也未部署。


## 2026-11-10 后续推进：R2 私有对象仓储原型

- [x] 新增 `nebula-r2-repository.js`：owner ID 仅取自服务端验证上下文；对象 ID 服务端生成；R2 key 固定为 `owners/{owner_id}/{category}/{object_id}`。
- [x] 上传、读取、列表前逐次检查服务端同步类别授权；不接受客户端 raw object key 或 owner ID。
- [x] D1 对象元数据读写按 owner_id + category + object_id 绑定；删除时先标记 deleting，再删 R2 对象与元数据，允许失败后重试。
- [x] 上传前先写入 D1 cleanup intent，再写 R2、再写 active 元数据；D1 元数据失败时执行 R2 补偿删除，补偿失败则保留可追踪 cleanup intent。
- [x] 新增 `migrations/0003_owner_scoped_objects.sql` 和模拟 R2/D1 契约测试，限制上传体积并校验 owner 前缀。
- [ ] R2/D1 repository 仍未接入 Worker 私有 API；必须在 Worker 中从服务端 consent ledger 读取授权并创建 repository，不得从请求体传入授权对象。
- [ ] 完成真实 D1/R2 测试环境应用迁移、A/B 用户跨账户上传/下载/列举/删除负向测试、失败补偿与并发撤销测试。

注意：当前上传体积限制通过有界缓冲后再写入 R2，属于受限体积原型，不是大文件流式上传方案。真实 Cloudflare R2/D1 未连接、未创建、未部署，未上传任何用户私人文件。



## 2026-11-11：Worker 私有同步 API 集成原型

- [x] Worker 新增认证后的 `/sync/consent`：GET 查询、POST 显式启用、暂停和撤销；启用必须携带 `confirm: true`，确认时间由服务端生成。
- [x] Worker 新增 `/sync/records`：按用户认证上下文和已启用类别执行 D1 查询、写入、删除。
- [x] Worker 新增 `/sync/objects`：按用户认证上下文和类别执行 R2 上传、列表、下载、删除；不接受原始 R2 key。
- [x] 所有私有同步 API 拒绝 `shared-service` 身份；没有有效服务端授权时拒绝读写。
- [x] 新增 Worker 级集成测试：合成签名 JWT、显式授权、记录读写、对象上传下载、B 用户越权下载拒绝、暂停和撤销后阻止数据访问。
- [ ] 当前集成测试使用模拟 D1/R2，不代表 Cloudflare 真实服务验证。
- [ ] Worker 尚未部署，D1/R2 bindings 未配置，三份 migration 未应用；wrangler.toml 仅保留注释模板。
- [ ] 后续必须在隔离测试 Cloudflare 环境验证真实 D1/R2、跨账户 CRUD、删除补偿、并发撤销和大文件上传。

## 2026-11-11：D1 授权复核与私人文件上传上限校正

- [x] /sync/records 在调用 D1 repository 前重新读取服务端 consent ledger，避免只依赖请求开始时的授权快照。
- [x] 新增集成测试：模拟请求开始时授权有效、D1 操作前授权已撤销，Worker 必须返回 403。
- [x] 修正 Worker 全局 1 MiB POST 限制与 R2 repository 10 MiB 上传上限不一致的问题：私人对象上传单独允许最多 10 MiB，其余 POST 路由仍为 1 MiB。
- [x] 新增 1 MiB 以上文件上传集成测试（模拟 R2）。
- [ ] 当前 D1 授权复核仍是操作前检查，不是与 SQL 读写处于同一原子事务；极窄的检查后撤销竞态仍需通过条件 SQL/事务边界进一步消除，并在真实 D1 验证。
- [ ] 10 MiB 上传目前仍经 Worker 有界缓冲后再写 R2，不是流式直传；大文件方案仍待独立设计。
- [ ] 上述测试仍使用模拟 D1/R2，不构成真实 Cloudflare 服务验证。

## 2026-11-11：D1 原子授权条件与 SQLite 迁移集成测试

- [x] D1 get/list/put/delete 的 SQL 均在同一条语句中校验服务端授权账本：owner 一致、status=enabled、JSON 类别列表包含当前类别。
- [x] 写入采用 INSERT ... SELECT ... WHERE EXISTS ... ON CONFLICT；撤销后即使仓储对象持有旧授权快照，也不能读取或变更数据。
- [x] 新增 Node SQLite 集成测试，执行三份真实 migration，并用真实 SQLite 引擎执行授权、双 owner 隔离、撤销后读写拒绝及重新授权删除测试。
- [x] 将 SQLite 集成测试纳入 NEBULA backend CI。
- [ ] SQLite 本地集成不等于 Cloudflare D1 生产兼容性验证；仍需在隔离的真实 D1 测试库运行 migration 和双账户测试。
- [ ] R2 是 D1 外部存储，授权检查与 R2 网络操作无法由单条 D1 SQL 原子包裹；仍需设计上传/下载/删除的竞态补偿和故障恢复。

## 2026-11-11：R2 删除失败恢复测试

- [x] 新增 R2 delete 失败注入测试：对象元数据保留为 deleting，重试可完成清理。
- [x] 新增 R2 删除成功但 D1 metadata delete 失败测试：保留 deleting 元数据，后续幂等重试完成清理。
- [ ] 目前是仓储级模拟故障注入；仍需在真实 Cloudflare R2/D1 测试资源上验证服务故障、超时和重试语义。


## 2026-11-11：R2 上传孤儿对象补偿加固

- [x] 新增 migration `0004_r2_upload_cleanup_intents.sql`，在 R2 上传前持久化 owner/category/object ID/object key 对应的 cleanup intent。
- [x] D1 active 元数据写入失败时尝试删除 R2；若 R2 删除也失败，cleanup intent 保留，不再静默丢失对象定位信息。
- [x] 新增 `reconcilePendingUploads()`：逐条检查 owner-scoped cleanup intent；若 active 元数据已存在，只清除陈旧 intent；若 active 元数据不存在，删除 R2 对象后再清除 intent。
- [x] 修正提交后清理 intent 失败的边界：不再误删已经有 active 元数据的 R2 对象；由后续 reconcile 安全清理陈旧 intent。
- [x] 新增故障注入覆盖：D1 metadata insert + R2 compensation delete 双失败，以及 active metadata 已提交但 cleanup intent 删除失败。
- [x] SQLite 集成测试现在执行四份 migration，并断言 cleanup 表存在。
- [ ] 当前 reconcile 仅为仓储方法，尚未接入 Worker 管理路由、定时任务或运维任务；没有自动重试调度。
- [ ] 故障注入仍是 Fake R2/Fake D1；需要在隔离真实 Cloudflare D1/R2 环境验证超时、重复执行和部分失败语义。

## 2026-11-12：R2 cleanup 定时恢复入口（代码已接入，环境待验证）

- [x] 新增 `nebula-r2-cleanup.js` 系统级恢复模块：从 D1 cleanup ledger 读取待处理记录，不接受请求方提供 owner ID 或 R2 object key；校验 owner/category/object ID，并重新派生、比对 object key。
- [x] 恢复任务只处理至少一小时前创建的 intent，降低与正在进行的上传发生竞争的风险；每轮最多 50 条。
- [x] 对每条记录先检查 D1 元数据：active 对象只清除陈旧 intent；无 active 元数据时才删除 R2 对象；R2/D1 失败保留 intent，等待下一轮重试。
- [x] Worker 增加 scheduled handler；Wrangler 配置每 15 分钟触发。未绑定 D1/R2 时 handler 安全跳过，不开放 HTTP 管理路由。
- [x] 新增调度恢复测试，覆盖跨 owner 记录、active 对象保护、近期上传保护、非法 key 拒绝、R2 失败保留和后续重试。
- [ ] 当前只有代码与 CI 测试；未部署 Worker，cron 尚未在 Cloudflare 实际启用。
- [ ] 必须在隔离测试环境应用 migration 0004 并绑定独立 D1/R2 后，验证 scheduled event、D1/R2 部分失败、并发上传超过一小时的边界及重试行为。
- [ ] 定时任务没有独立审计表或告警通道；当前返回批次结果供运行时执行，不输出对象正文或用户数据。后续真实环境需补充脱敏指标、失败告警和运维可观测性。


## 2026-11-12：R2 cleanup 批次公平性修复

- [x] 审计发现非法 cleanup intent 会一直留在最旧的 pending 列表中，可能长期占据每轮 50 条批次名额。
- [x] migration 0004 增加 status（pending/quarantined）字段，并调整索引优先支持 pending 扫描。
- [x] 调度器只读取 pending intent；发现 owner/category/object ID/key/timestamp 不符合约束时，将该行标记为 quarantined，保留记录供人工审查，不会调用 R2 删除，也不再重复阻塞后续批次。
- [x] 增加 55 条非法记录压在有效记录之前的公平性测试，验证第二轮能处理后续有效对象；SQLite migration 集成测试检查状态字段。
- [ ] 仍需在真实 D1 验证 migration 兼容性及定时任务执行行为。
- [ ] 超长上传与 scheduler 交错仍未通过原子状态机彻底消除；一小时宽限期只是风险缓解。后续需设计上传完成与 cleanup claim 的原子竞争协议，并增加双 scheduler 并发、上传提交交错及 R2 成功/D1 intent 删除失败测试。

- CI note: first run of this fairness patch caught an outdated expected action label in the test; the assertion was corrected in the follow-up commit. The corrected head still requires a fresh workflow run before this patch can be called green.


## 2026-11-13：R2 上传提交与 cleanup scheduler 原子竞争协议（代码已提交，CI 待验证）

- [x] cleanup intent 状态细化为 `uploading`、`pending`、`processing`、`quarantined`；上传先登记为 `uploading`，不再被普通 pending 批次立即认领。
- [x] 上传元数据采用条件 INSERT ... SELECT：只有 cleanup intent 仍为 `uploading` 时才能提交 active metadata；若 scheduler 已认领，上传提交失败并进入 R2 补偿路径。若即时 R2 补偿失败且记录尚未被 scheduler 认领，则转入 `pending`，进入后续批次。
- [x] scheduler 使用单条条件 UPDATE 原子认领 intent，并在 SQL 内排除已有 active metadata 的对象；双 scheduler 对同一条记录竞争时，只有一个能成功认领。
- [x] processing 认领带 30 分钟 lease；scheduler 崩溃后可在 lease 到期后重试。R2 delete 幂等，D1 intent 仅在匹配 processing lease 时清除。
- [x] 保留至少一小时上传宽限期、50 条批次上限和非法记录 quarantine。
- [x] 代码与 SQLite 并发测试已通过 GitHub Actions（最新代码测试 head `d4f411ea70af7bccf0ab44b51cd287b8091f12fa`：NEBULA backend checks #654、local backend validation #156、Jekyll site CI #743 均 success）。Fake R2/SQLite 测试仍不等于真实 Cloudflare 并发 D1/R2 测试。
- [ ] 30 分钟 lease 是崩溃恢复窗口，不是 R2 外部操作的 fencing token；仍需真实 Cloudflare D1/R2 环境验证超时、重复删除、长时间挂起及跨服务部分失败。
- [ ] migration 0004 尚未应用到真实 D1；Worker 未部署，Cron 未启用。


## 2026-11-13 follow-up: user-scoped cleanup recovery fencing

- [x] A second cleanup path existed inside the owner-scoped R2 repository. It previously selected every owner intent, including fresh `uploading` rows, and could delete an object while upload completion was still in progress.
- [x] User-scoped recovery now selects only explicit `pending` intents or expired `processing` leases; it never selects `uploading` rows.
- [x] It validates and re-derives the object key, atomically claims with a lease and active-metadata guard, and clears only the matching processing lease after R2 deletion.
- [x] Added a regression test proving a fresh `uploading` intent is neither selected nor deleted by user-scoped recovery.
- [ ] Latest PR head CI is pending; no live Cloudflare validation has occurred.


- [x] Follow-up regression found during CI: successful uploads can retain an `uploading` intent if the post-commit intent delete fails. Owner-scoped recovery now selects such a row only when matching active metadata exists, then removes the intent with an SQL `EXISTS(active)` guard; it never deletes the R2 object.
- [x] The same recovery path continues to exclude fresh `uploading` rows without active metadata.
- [x] Latest code/test head `f52c301e7e270a3d3813088353eb9465f275eb4e` passes NEBULA backend checks #657, local backend validation #160, and Jekyll site CI #746. The preceding head correctly failed on the new committed-intent test; the active-metadata-only recovery selection fixed it.


## 2026-11-13: isolated test environment preparation and final CI checkpoint

- [x] Added `wrangler.test.example.toml`: separate `nebula-private-test` Worker, dedicated D1/R2 binding placeholders, Clerk JWT test placeholders and test-only Cron. No production resource identifiers or secrets are included.
- [x] Added `docs/NEBULA-TEST-ENVIRONMENT-RUNBOOK.md`: gated D1/R2 provisioning, Clerk test configuration, secret setup, remote migration, Worker deployment, two-account E2E matrix and teardown.
- [x] Added ignore rules for local filled test config, local vars, environment files, Wrangler state and node_modules.
- [x] Latest PR head `85dd5ad34b63530972938ad3b0c36b7ff322fc47`: backend checks #664, local backend validation #166, Jekyll site CI #753 all success.
- [ ] Cloudflare D1/R2/Worker resources have not been created; no remote migration, secret write or deploy was executed. User authorization remains required before those actions.


## 2026-11-13: durable user-requested R2 deletion recovery

- [x] 审查发现旧删除流程在 R2 删除失败或 D1 收尾失败时，可能长期留下 `deleting` 元数据；旧流程没有为主动删除建立独立、持久的恢复意图。
- [x] `deleteObject()` 现在使用 D1 `batch()` 原子地将对象标记为 `deleting` 并写入 cleanup intent；R2 删除失败时，intent 保留，不丢失对象定位信息。
- [x] R2 删除成功后，D1 通过 batch 收尾；若收尾失败，scheduler 可重复执行幂等 R2 delete，再删除 `deleting` 元数据与 intent。
- [x] 新增 migration 0005 `intent_kind`，区分 upload/delete：上传 intent 继续保留一小时安全宽限；用户主动删除 intent 立即可被 scheduler 认领。
- [x] 系统 scheduler 与 owner-scoped recovery 均在 R2 删除成功后清除 `deleting` 元数据；processing lease 仍通过 lease_expires_at 做条件删除。
- [x] SQLite 集成测试覆盖：最近 30 秒内创建的 delete intent 即使未满一小时也能恢复；R2 首次删除失败后 scheduler 删除对象并清除 D1 元数据和 intent。
- [x] R2 仓储与 Worker API 回归测试覆盖 D1 batch 持久化和撤销授权后仍允许用户删除自己的云端副本。
- [x] 最新代码/测试 head `e6ede49a3cfd66989477570fa1d0e65df5b664c5`：NEBULA backend checks #697、local backend validation #199、Jekyll site CI #786 均 success；SQLite 实际迁移/SQL、删除失败自动恢复、即时 delete intent 资格、Worker API 和本地 Wrangler D1/R2 smoke 均通过。
- [ ] Cloudflare 真实 D1 batch 事务、R2 删除幂等与 Cron 时序仍待隔离云端验证；当前证据来自 SQLite、Fake R2 与本地 Wrangler。


## 2026-11-13: preserve owner deletion rights after sync revocation

- [x] 审查发现记录型数据与文件型数据行为不一致：文件允许撤销后删除本人云端副本，但记录删除仍被同步授权检查阻断。
- [x] `DELETE /sync/records` 现在与 `DELETE /sync/objects/:id` 一样，仅允许经过验证的个人用户删除自己 owner scope 内的数据；其他读取/写入仍必须通过有效授权检查。
- [x] D1 `deleteRecord()` 只按服务端 owner_id + record_type + record_id 删除，不再要求同步授权有效；读/写仍由请求快照和 SQL 实时授权双重限制。
- [x] D1 仓储允许以 revoked/paused/无授权快照构造只可删除的实例；任何读取和写入仍会失败关闭。
- [x] Worker API 与真实 SQLite 集成测试覆盖：撤销后读取被拒绝、本人记录删除成功、删除后记录确实不存在。
- [x] 最新代码/测试 head `1325d44475ebde423b2e6f1281b1ec9c54f0adfa`：NEBULA backend checks #707、local backend validation #209、Jekyll site CI #796 均 success。
- [ ] 真实 Clerk + Cloudflare D1/R2 双账户端到端验证仍待隔离云端资源；未部署正式 Worker、未迁移正式数据。
