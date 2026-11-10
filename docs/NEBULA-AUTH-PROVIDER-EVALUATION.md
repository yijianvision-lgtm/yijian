# NEBULA 第三方身份服务选型评估（Clerk / Auth0）

评估日期：2026-11-10  
状态：**初步评估完成；尚未选定服务；未创建供应商账户、未配置密钥、未接入或部署。**

## 1. 必须满足的产品边界

用户已选择 B：**本地优先＋用户主动开启云同步（Local-first + Opt-in Cloud Sync）**。

- 登录、刷新令牌、重新打开应用不得触发私人数据上传。
- IndexedDB 继续作为独立本地数据层；认证服务或网络故障不得影响本地资料。
- 身份提供方只承担注册、登录、身份验证、会话与账户生命周期，不作为私人知识库、讲义、原始文件或历史对话的默认存储方。
- 云同步默认关闭；用户明确选择同步范围并确认后才同步。
- AI 单次请求与云同步授权分开处理。
- Worker 必须验证面向 NEBULA API 的访问令牌；不能把客户端 userId/ownerId 当作身份依据。
- 服务端从可信 issuer + subject 派生内部 owner_id；供应商用户 ID 仅作为可信身份断言的一部分，不能由请求体覆盖。

## 2. 供应商比较

| 维度 | Clerk | Auth0 |
|---|---|---|
| 产品定位与体验 | 面向开发者的用户认证和账户组件，提供预制注册、登录、个人资料 UI | 成熟的身份与访问管理平台，适合多种应用与更复杂的 IAM 场景 |
| 个人用户登录 | 邮箱密码、邮箱验证码/链接、社交登录等 | 数据库连接、密码less、社交连接等 |
| JWT / API 验证 | Clerk session JWT；支持自定义 JWT 模板；提供公开验证密钥/JWKS 与服务端验证方式 | 支持为自定义 API 配置 audience 并签发 JWT access token；租户 JWKS 用于签名验证 |
| Worker 集成关注点 | 需要核实所选 SDK/运行时与 Cloudflare Workers 的兼容性；可用固定 issuer、audience 和公钥/JWKS 验证 | 必须为 NEBULA API 配置 audience，避免拿到 opaque token；严格验证 issuer、audience、RS256、kid 与时效 |
| 会话/账户管理 | 提供会话管理、设备会话撤销等能力；具体套餐限制需按生产计划核对 | 有成熟的身份生命周期和企业 IAM 能力；不同功能随套餐变化 |
| 价格口径 | MRU（月留存用户），不是 MAU | MAU（月活跃用户） |
| 当前公开免费层 | 每个应用最多 50,000 MRU；Hobby 对 MFA、会话时长、品牌等有功能限制 | 最多 25,000 MAU；免费层包含若干身份与组织功能，但存在功能/流量限制 |
| 付费与规模成本 | Pro 页面当前显示年付折算 $20/月；超额 MRU 按公开阶梯计费，需注意月付/年付差异 | Essentials 当前显示 $35/月起，但计费档位、MAU 与功能限制需按目标应用重新核价 |
| 数据可迁移性 | 用户资料可导出；认证凭据、密码哈希和会话不能假定可无损迁移，需制定账户迁移/重设验证流程 | 用户资料可导出；认证凭据迁移依赖源/目标密码哈希兼容与供应商流程，不能假定可直接搬迁 |
| 主要风险 | 组件体验便利但会形成一定 SDK/产品耦合；免费档 MFA、Passkeys、品牌等限制需核验 | 配置项和套餐复杂度较高；必须正确配置 API audience/token format，否则可能拿到 opaque token 而非 JWT |

## 3. 公开资料与核验链接

### Clerk
- Pricing: https://clerk.com/pricing
- JWT templates: https://clerk.com/docs/guides/sessions/jwt-templates
- Manual JWT verification: https://clerk.com/docs/guides/sessions/manual-jwt-verification
- verifyToken reference: https://clerk.com/docs/reference/backend/verify-token
- Session tokens: https://clerk.com/docs/guides/sessions/session-tokens

关键核验点：
- Clerk 提供签名 session JWT；手动验证时应固定可信公钥/JWKS，并校验预期算法、签名、exp、nbf、issuer、audience（如配置）及授权来源。
- 不把 Clerk user metadata 当作 NEBULA 私人知识存储。
- Clerk JWT 模板可用于外部服务集成，但不要把私人内容或不必要的个人资料写进 JWT claims。

### Auth0
- Pricing: https://auth0.com/pricing
- JWKS: https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets
- Token formats: https://support.auth0.com/center/s/article/opaque-versus-jwt-access-token
- JWT validation quickstart: https://auth0.com/docs/quickstart/backend/golang/interactive
- Signing key rotation: https://support.auth0.com/center/s/article/Tenant-Signing-Key-Rotation

关键核验点：
- 为 NEBULA API 注册独立 API identifier / audience；授权请求必须带 audience，以确保取得适用于该 API 的 JWT access token。
- 不得把 opaque token 当 JWT 解码或仅凭客户端解析结果授权。
- API 侧使用固定 issuer、audience、RS256 和 JWKS 验证签名，并处理 kid/key rotation。
- ID token 用于客户端身份信息；访问受保护 API 应使用面向该 API 的 access token。

### Cloudflare Workers
- Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Clerk backend-only SDK（V8 isolates）：https://clerk.com/docs/guides/development/sdk-development/backend-only
- Auth0 SPA SDK（Authorization Code + PKCE）：https://auth0.github.io/auth0-spa-js/
- Cloudflare Workers JWT validation guidance：使用 Web Crypto/JWKS 的运行时注意事项见 https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

Workers Runtime 提供 Web Crypto API，可执行公钥签名验证。Clerk 官方 backend-only SDK 文档明确其基础包面向 Node.js/V8 isolates（包括 Cloudflare Workers），因此 Clerk 在 Worker 端的技术兼容性风险较低；但仍须在本仓库实际运行时验证包体、模块导入、验证路径和失败行为。Auth0 SPA SDK 可用于浏览器端 PKCE 登录，Worker 端应使用标准 JWT/JWKS 验证，不应把浏览器 SDK 当作 API 授权层。正式实现前仍须验证算法、JWK 导入、缓存与密钥轮换行为；不能只凭文档声明通过。

## 4. 初步判断

### 第一候选：Clerk（有条件）

理由：
1. 当前产品首先需要个人账户注册、登录、会话管理与顺畅的前端体验。
2. Clerk 提供较完整的预制 UI 和开发者集成路径，可能缩短 M0/M1 的实现周期。
3. 当前公开免费层的 50,000 MRU 对早期测试有吸引力，但 MRU 与 MAU 不可直接横向等同。
4. Clerk 官方文档明确其 backend SDK 面向 V8 isolates/Cloudflare Workers；这降低了 Worker SDK 兼容性的不确定性，但不替代本仓库实测。

需要先解决的条件：
- 确认其当前生产套餐、MFA/Passkeys、域名、账户恢复、删除、会话撤销和支持政策是否满足长期要求。
- 在 Cloudflare Workers 运行时验证官方 SDK 或手动验证路径；若使用手动验证，必须完成固定 issuer/audience、RS256、JWKS 轮换、缓存和失败关闭测试。
- 验证 GitHub Pages 当前应用域名、未来自定义域名和回调 URL 的配置方式。
- 明确账户迁移方案，避免供应商耦合导致未来无法迁出。

### 备选：Auth0

适用情形：
- 未来需要更复杂的企业 IAM、细粒度授权或更广泛的身份集成。
- 愿意承担更高的配置复杂度，并根据实际 MAU、功能与生产套餐重新核价。

关键阻塞：
- 必须正确配置 NEBULA API audience 并获取 JWT access token。
- 必须明确生产所需功能是否包含在所选套餐；免费层不能作为长期生产承诺。

### 当前结论

**推荐先以 Clerk 作为测试阶段的首选候选，但暂不锁定供应商。**  
Auth0 保留为备选。最终决策前应完成真实报价核对、Cloudflare Worker 最小验证原型、账户生命周期检查和迁移评估。

## 5. 供应商无关的实施架构

前端：
- 通过 Auth Adapter 封装 `signIn`、`signOut`、`getSession`、`getAccessToken`。
- UI 不直接依赖供应商用户对象；映射为 NEBULA 内部的标准身份状态。
- 登录状态与云同步开关完全分离。
- 默认 `cloudSyncEnabled=false`；登录不能修改该值或启动同步。
- IndexedDB 仍是本地数据主存储；同步按用户授权的资料类别建立独立队列。

Worker：
- 只接受为 NEBULA API 签发的短时效 access token。
- 固定 issuer、audience、允许算法和 JWKS 来源；拒绝 `alg=none`、未知 kid、错误签名、过期/未生效令牌。
- JWKS 缓存必须支持轮换；未知 kid 可触发一次受控刷新，刷新失败时拒绝请求。
- 只从验证后的 `iss` 与 `sub` 派生内部 owner_id。
- 所有 D1/R2 访问都在服务端执行 owner scope；不能相信请求体 owner 字段。
- 不在 JWT 中放私人讲义、知识内容、文件名或敏感资料。

供应商替换：
- 将 provider-specific SDK 限制在 Auth Adapter 和服务端验证层。
- 维护独立的内部账户映射表；不要把供应商 user ID 直接作为所有业务表的主键。
- 账户迁移需覆盖身份重新验证、邮箱验证、密码重设/凭据迁移、会话失效和审计；不可承诺密码哈希一定可迁移。

## 6. 下一步验证任务

1. 以 Clerk 为首选候选建立隔离的本地/测试验证原型，不创建生产环境资源。
2. 核对 Clerk SDK 在 Cloudflare Workers 的运行时兼容性；比较官方验证 SDK 与 JWKS/Web Crypto 手动验证方案。
3. 设计标准化 Auth Adapter 接口和 provider-neutral JWT 验证契约。
4. 添加合成 JWT 测试：合法、过期、错误 issuer、错误 audience、alg=none、未知 kid、签名错误、JWKS 超时/错误响应、密钥轮换。
5. 评估账户删除、会话撤销、账号恢复、邮箱变更、重复账户合并和供应商迁移。
6. 只有在用户明确批准供应商并确认测试环境后，才创建独立测试应用/租户；不得部署 Worker 或接入真实用户数据。

## 7. 决策记录

- 用户已批准产品数据模式 B，不等于批准 Clerk 或 Auth0。
- Clerk 是当前第一候选，不等于最终选型。
- 本评估未创建供应商账户、未输入用户个人资料、未配置 API key/secret、未修改 Cloudflare 资源。
- 正式后台和真实私人数据迁移仍被禁止，直到身份认证、owner 隔离、备份恢复、双用户 E2E 和用户验收全部通过。
