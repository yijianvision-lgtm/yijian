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
