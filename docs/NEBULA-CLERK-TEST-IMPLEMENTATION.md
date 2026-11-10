# NEBULA Clerk 测试阶段实施边界

状态：**Clerk 已由用户确认作为测试阶段首选；尚未创建 Clerk 应用/实例，尚未配置密钥，尚未接入生产 Worker。**

## 已确认决定

- Clerk 是测试阶段首选身份提供方。
- Auth0 保留为供应商替换备选，不再作为当前并行实施路线。
- 用户选择 B：Local-first + Opt-in Cloud Sync。
- 该确认只授权按 Clerk 方向推进设计和本地/合成数据原型；不授权创建或修改生产资源、部署 Worker、迁移真实账户或上传私人资料。

## 实施分层

1. NEBULA 前端只依赖内部 Auth Adapter 接口，不把 Clerk SDK 类型传播到知识引擎。
2. Clerk provider adapter 是唯一允许接触 Clerk SDK 的前端边界。
3. Worker 只信任服务端验证后的身份断言；不得信任请求体中的 userId/ownerId/tenantId。
4. 内部 owner_id 由服务端基于经过验证的 issuer + subject 派生；业务表不直接以供应商用户 ID 作为跨系统主键。
5. 同步授权存储与身份会话分离；登录、令牌刷新、重新打开应用不得写入同步授权或启动同步。
6. 云同步默认关闭；用户明确确认并选择资料类别后才启用。
7. 当前 Worker 的共享 NEBULA_SYNC_TOKEN 仍不是用户身份，不能用于多用户私有数据访问。

## 当前代码原型

- `nebula-auth-adapter.js`：供应商无关的前端认证边界；注入 provider 与 consent store，不含供应商 SDK或网络请求。
- `nebula-jwt-verify.js`：供应商无关的 RS256/JWKS 验证原语；固定 issuer、audience、HTTPS JWKS URL，并可强制 authorized party allowlist；拒绝 `alg=none`、令牌自带 `jku/x5u`、错误签名、过期/未生效令牌和未知密钥；JWKS 响应设大小上限、请求超时、RSA 最低 2048 位并拒绝重复 kid；未知 `kid` 只触发一次受控 JWKS 刷新。
- `deriveNebulaOwnerId()`：使用服务端 namespace secret 对已验证的 issuer + subject 做 HMAC-SHA-256 命名空间派生；不接受客户端 owner_id。此函数尚未接入 Worker 路由或 D1。
- `tests/auth-adapter.test.mjs`：合成身份测试，覆盖登录不授权同步、同步显式确认、类别白名单、登出与关闭同步。
- `tests/jwt-verify.test.mjs`：合成 RSA 密钥测试，覆盖有效签名、缓存、过期、错误 issuer/audience、空 subject、未来 nbf、`alg=none`、恶意 jku、签名错误、未知 kid、密钥轮换、JWKS 故障及 owner_id 稳定性。
- 这些模块目前未接入 `index.html`、`nebula-local.js` 或 `deepseek-worker.js`，因此不改变现有用户流程。JWT 验证模块使用配置注入的固定 JWKS URL；本轮测试仅使用本地生成的合成 RSA 密钥与模拟 JWKS，不访问 Clerk，也不代表真实 Clerk token 已验证。

## Clerk 集成前的安全要求

- 在独立 Clerk development/test instance 配置 NEBULA 测试 API audience/issuer 与允许来源。
- 明确 Clerk session token 与面向 NEBULA API 的 access token 的用途；Worker 只接受预期 token 类型、固定 issuer/audience、明确算法及允许的 authorized parties。
- 官方 `@clerk/backend` SDK 可面向 Cloudflare Workers/V8 isolates；优先评估 `authenticateRequest()` 与固定 `jwtKey` 的 networkless 验证路径。必须在本项目实际运行时测试，不能只依赖文档。
- 若采用 PEM/JWKS 验证，必须固定受信任来源，拒绝 `alg=none`、未知密钥、错误签名、issuer/audience 不匹配、过期/未生效令牌。
- 验证失败、密钥配置缺失或身份服务异常时 fail closed。
- 测试 issuer/audience、密钥轮换、撤销窗口、登出、账户删除/恢复、邮箱变更和用户迁移。
- 不将私人内容、文件名、知识节点或对话文本放进 JWT claims 或 Clerk metadata。

## 下一阶段

1. 完成 provider adapter 的 Clerk 实现（仅在独立测试配置可用后）。
2. 为 Worker 增加服务端 Clerk token 验证层和合成负向测试。
3. 实现 issuer + subject 到内部 owner_id 的服务端派生。
4. 建立隔离测试 D1/R2 schema 和 A/B 用户越权负向测试。
5. 接入前端认证 UI，但保持 IndexedDB 本地模式独立可用。
6. 最后才实现用户明确授权的云同步 adapter。

在以上测试与安全评审完成前，测试后台仍不可接入真实数据，正式后台仍禁止接入。


## 2026-11-10 安全审计增量

- Worker 对现有共享 Bearer token 的比较改为固定长度遍历的常量时间比较；该令牌仍只是部署级共享访问令牌，不构成用户身份认证。
- Worker 上游 HTTP 请求增加连接超时；上游响应体读取增加 20 秒总时限，并继续执行 8 MiB 大小限制。
- JWT/JWKS 验证器增加 JWKS 256 KiB 默认响应上限、5 秒默认请求超时、RSA 公钥至少 2048 位检查、重复 kid 拒绝及公钥用途/私钥材料检查。
- 合成测试覆盖 JWKS 超时、超大响应、重复 kid 和弱 RSA 密钥。
- 以上是代码级加固；真实 Clerk 签名验证、Cloudflare Worker 运行时、JWKS 网络故障与真实密钥轮换仍需独立测试。未部署任何 Worker 或云资源。

- JWT 验证器支持配置 Clerk azp authorized party 白名单；启用后，缺失或不在白名单的 azp 一律拒绝。

- 2026-11-10 后续审计：Worker 入站请求体读取增加 15 秒总时限，超时返回 408 并取消读取；保留 1 MiB 限制并传播客户端 AbortSignal。
- JWT 验证要求有限且有效的 iat/exp，拒绝未来签发时间、exp 不晚于 iat、超过 1 小时最大有效期的令牌；Clerk 实际 token claims 仍需在真实测试实例核对。
- 2026-11-10 请求处理顺序调整为：共享令牌鉴权 → per-IP/per-route 限流 → 读取并限制请求体；避免已认证请求在限流前占用请求缓冲资源。
- 2026-11-10 前端安全审计发现并修复一个存储型 XSS：时间轴将本地/导入节点的 date 字段插入 innerHTML；现改为 DOM textContent，并加入回归契约测试。其余检查到的动态 innerHTML 字段使用 esc() 转义或改用 textContent/DOM 节点；仍需后续持续审计。


## 2026-11-10：Worker 可信身份中间件原型（未启用）

新增 `nebula-worker-auth.js`，Worker 的 `/share` 与 AI/研究路由统一经过身份中间件：

- 默认兼容模式为 `shared`，只返回 `kind: "shared-service"`，绝不派生或伪造用户 `owner_id`。
- 可选 `clerk-jwt` 模式使用固定服务端 issuer、audience、HTTPS JWKS URL、JSON 格式 authorized-party allowlist 和服务端 namespace secret。
- JWT 模式验证成功后，仅使用已验证的 `iss/sub` 派生 HMAC owner ID；客户端请求体中的 owner 字段不会参与身份计算。
- JWT 模式配置不完整、authorized-party 配置无效、身份服务不可用时 fail closed；不会回退到共享令牌。
- 验证器在 Worker isolate 内按可信 issuer/audience/JWKS/party 配置缓存，避免每个请求重建 JWKS 缓存。
- Worker 已移除 AI 路由重复的共享令牌检查，统一使用中央身份中间件。
- 新增独立中间件合成测试，以及 Worker 路由实际验签的合成 RSA/JWKS 集成测试。

**重要限制：** 该模式只是可配置的 Clerk 风格 JWT 验证接入边界，不代表真实 Clerk 实例已创建、真实 Clerk token claims 已确认或 Clerk SDK 已安装。没有设置 `NEBULA_AUTH_MODE=clerk-jwt`，没有设置生产身份参数，没有部署 Worker。默认仍为共享服务令牌兼容模式；共享令牌不是用户身份。当前 Worker 尚无 D1/R2 私有数据路由，因此 owner ID 目前只建立在认证上下文中，尚未用于任何数据库或对象存储授权。


## 2026-11-10：Worker 可信身份中间件原型（未启用）

新增 nebula-worker-auth.js，Worker 的 /share 与 AI/研究路由统一经过身份中间件：

- 默认兼容模式为 shared，只返回 kind: shared-service，绝不派生或伪造用户 owner_id。
- 可选 clerk-jwt 模式使用固定服务端 issuer、audience、HTTPS JWKS URL、JSON 格式 authorized-party allowlist 和服务端 namespace secret。
- JWT 模式验证成功后，仅使用已验证的 iss/sub 派生 HMAC owner ID；客户端请求体中的 owner 字段不会参与身份计算。
- JWT 模式配置不完整、authorized-party 配置无效、身份服务不可用时 fail closed；不会回退到共享令牌。
- 验证器在 Worker isolate 内按可信 issuer/audience/JWKS/party 配置缓存，避免每个请求重建 JWKS 缓存。
- Worker 已移除 AI 路由重复的共享令牌检查，统一使用中央身份中间件。
- 新增独立中间件合成测试，以及 Worker 路由实际验签的合成 RSA/JWKS 集成测试。

重要限制：该模式只是可配置的 Clerk 风格 JWT 验证接入边界，不代表真实 Clerk 实例已创建、真实 Clerk token claims 已确认或 Clerk SDK 已安装。没有设置 NEBULA_AUTH_MODE=clerk-jwt，没有设置生产身份参数，没有部署 Worker。默认仍为共享服务令牌兼容模式；共享令牌不是用户身份。当前 Worker 尚无 D1/R2 私有数据路由，因此 owner ID 目前只建立在认证上下文中，尚未用于任何数据库或对象存储授权。


## 2026-11-10：D1 owner-scoped repository prototype（未接入路由）

- 新增 nebula-d1-repository.js；构造器只接受 kind=user 且符合 own_ + 64 位小写十六进制格式的服务端 owner ID。
- get/list/put/delete 全部由闭包捕获 owner ID；方法签名不接受 owner 参数；SELECT/DELETE 显式 owner_id 条件；UPSERT 使用 owner_id + record_type + record_id 复合冲突键。
- record type/id 严格校验；payload 只接受 JSON object，限制 256 KiB；分页最多 50 条。
- 新增 migrations/0001_owner_scoped_records.sql，以 (owner_id, record_type, record_id) 作为主键，并添加 owner/type/update 索引和 JSON object/大小约束。
- 新增合成 D1 binding 契约测试，验证所有 SQL 首个绑定值为服务端 owner ID，客户端 payload 中的 owner_id 不改变实际行归属。

限制：目前没有 D1 binding、没有创建/应用迁移、没有真实 SQLite/D1 双用户测试；此 repository 尚未被 Worker 路由调用，也没有 R2 存储/对象 API。不可宣称 D1/R2 多租户隔离已经完成。

- D1 repository 后续增加强制 server-verified syncConsent：只有 enabled=true、有效 confirmedAt 且包含对应 record_type 类别时才允许读写；无授权类别在发起 D1 查询前拒绝。该 consent 必须由未来 Worker 从服务端授权记录读取，绝不能直接采用客户端请求体声明。
