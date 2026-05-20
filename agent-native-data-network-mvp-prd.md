# Agent Native Data Network MVP PRD

## 1. MVP 目标

本 MVP 的目标不是完成最终形态的通用数据网络，而是跑通一个最小、可信、可演示的核心流程：

> 用户为主 Agent 接入一次 Discovery Connector -> 数据方把一个已有数据能力接入网络 -> 需求方 Agent 通过 Connector 发现该服务 -> 查看服务目录和样本响应 -> 通过 x402 支付 -> 获取真实结构化数据 -> 调用结果被记录为基础信任信号。

MVP 需要证明：

1. 数据方不需要重新开发完整产品，也能把已有 API、CLI、skill、MCP server 或数据集包装成可调用服务。
2. 需求方 Agent 只需要接入一次 Discovery Connector，不需要用户为每个数据源手动安装工具或配置 API key，也能发现并调用数据服务。
3. 付费调用可以复用 x402，而不是自建支付协议。
4. Agent 身份、服务注册和初步信誉可以尽量复用 ERC-8004，而不是从 0 设计信任网络。
5. 返回数据格式足够适合 Agent 后续推理和组合调用。

## 2. MVP 范围

### 2.1 做什么

- 支持 1 个服务注册表。
- 支持 1 个 Discovery Connector，作为 Codex / Claude / Cursor 等主 Agent 的 bootstrap 入口。
- 支持 1-3 个数据方服务接入。
- 支持一种 MVP 查询场景：链上数据查询。
- 支持服务 manifest。
- 支持样本响应 preview。
- 支持 schema 校验。
- 支持 x402 付费调用。
- 支持 Agent-friendly JSON 返回格式。
- 支持基础调用记录和反馈记录。
- 支持 ERC-8004 身份/服务文件的最小兼容。

### 2.2 不做什么

- 不做完整通用市场。
- 不做 token 激励。
- 不做复杂竞价。
- 不做完整仲裁。
- 不做自动退款系统。
- 不做复杂 UI。
- 不做多行业同时扩张。
- 不自研新的支付标准。
- 不自研完整信誉协议。

## 3. 推荐复用标准

### 3.1 x402：支付层

MVP 使用 x402 作为付费调用的默认协议。

职责边界：

- 服务方 endpoint 在未携带有效 payment 时返回 HTTP 402。
- 402 response 告诉需求方 Agent 价格、资产、网络和支付要求。
- 需求方 Agent 完成支付后重试请求。
- 服务方验证支付后返回真实数据。

MVP 不重新设计：

- 支付请求格式
- 支付验证流程
- HTTP 402 语义
- settlement 逻辑

### 3.2 ERC-8004：Agent 身份与基础信任层

MVP 尽量兼容 ERC-8004 的思路，而不是自建一套 Agent 身份和信誉协议。

职责边界：

- 数据方 Agent 使用 ERC-8004 风格 identity 表示自己的服务主体。
- Agent registration file 描述该 Agent 的 endpoint、服务、钱包、能力和支持的信任模型。
- 服务 manifest 可以作为 registration file 的一部分，或由 registration file 指向。
- 每次成功调用后，可以记录一条最小反馈信号。
- 未来可接入 ERC-8004 reputation registry 和 validation registry。

MVP 不要求一开始实现完整链上信誉和验证系统。可以先做：

- 本地/off-chain 反馈记录
- 可选写入 ERC-8004 reputation registry
- 可选记录交易哈希、request_id、service_id

### 3.3 JSON Schema / OpenAPI：服务描述层

MVP 使用 JSON Schema 描述输入和输出结构。

可选支持 OpenAPI，用于描述 HTTP endpoint，但 MVP 的核心是 service manifest，而不是完整 API 文档系统。

## 4. 角色定义

### 4.1 数据方 Provider Agent

拥有某种数据访问能力的一方。

可能的底层能力：

- 已配置 API key 的 API wrapper
- 已安装 CLI
- 已安装 skill
- 已配置 MCP server
- 自建数据库
- 静态或人工维护数据集

Provider Agent 的目标是把该能力包装成一个标准服务，供其他 Agent 按次付费调用。

### 4.2 需求方 Consumer Agent

需要完成用户任务的主 Agent。

Consumer Agent 不直接拥有 API key，也不需要提前安装每个数据方工具。它通过用户一次性接入的 Discovery Connector 访问 registry，通过 manifest 理解服务，通过 x402 支付后调用服务。

典型 Consumer Agent：

- Codex
- Claude
- Cursor agent
- 自研研究 Agent
- 自动化交易 / 研究 workflow

### 4.3 Discovery Connector

主 Agent 不会天然知道本网络存在，因此 MVP 必须提供一个最小 bootstrap 入口。

Discovery Connector 是主 Agent 连接本网络的唯一预装组件。它可以实现为：

- MCP server：适合 Claude、Cursor 等支持 MCP 的客户端。
- CLI：适合 Codex 或本地 coding agent。
- Skill / plugin：适合有自定义工具系统的 Agent 环境。
- HTTP tool：适合已经允许配置远程工具的 Agent。

MVP 优先实现一种形态，建议优先选择 MCP server 或 CLI。

Discovery Connector 暴露的工具：

- `search_services(query, filters)`
- `get_manifest(service_id)`
- `preview_service(service_id, input)`
- `invoke_paid_service(service_id, input, budget)`
- `get_feedback(service_id)`

产品承诺需要明确为：

> 用户只安装一次 Discovery Connector；之后主 Agent 可以发现和调用网络内的多个数据服务，而不需要为每个服务分别安装 skill、MCP server、CLI 或配置 API key。

### 4.4 Registry

MVP 中的服务注册表。

职责：

- 接收服务注册。
- 存储 service manifest。
- 存储 provider identity。
- 存储样本响应。
- 存储 schema 校验状态。
- 支持服务搜索。
- 返回服务候选列表。

### 4.5 Validator

MVP 中的接入验证器。

职责：

- 模拟请求 provider endpoint。
- 校验响应是否符合 schema。
- 校验样本响应是否结构合法。
- 标记服务状态：pending、verified、failed。

MVP 的 Validator 不验证数据真实性，只验证服务可调用性和格式正确性。

## 5. 核心用户故事

### 5.1 数据方接入

作为 Bob，他已经拥有某个链上数据 API 的访问权限，或已经在本地配置好了某个 CLI / skill。

Bob 希望：

1. 创建一个 Provider Agent 身份。
2. 描述自己可以提供什么数据。
3. 上传或生成 service manifest。
4. 提供一个 endpoint。
5. 设置每次调用价格。
6. 提供样本请求和样本响应。
7. 通过平台模拟请求验证。
8. 被其他 Agent 发现和调用。

### 5.2 需求方调用

作为用户的主 Agent，它需要完成：

> 分析 Base 链过去 7 天资金流向。

主 Agent 希望：

1. 通过 Discovery Connector 搜索可以提供 `base fund flow 7d` 的服务。
2. 读取候选服务 manifest。
3. 查看样本响应和字段解释。
4. 判断价格和可信度是否可接受。
5. 发起 x402 支付。
6. 获取真实数据。
7. 基于数据生成最终分析。
8. 给服务留下基础反馈信号。

## 6. 端到端流程

### 6.1 Provider Onboarding

1. Provider 创建或连接 Agent identity。
2. Provider 填写服务信息。
3. Provider 选择接入方式：API、CLI、skill、MCP、database、dataset。
4. Provider 提供 endpoint。
5. Provider 提供 input_schema 和 output_schema。
6. Provider 提供 sample_request 和 sample_response。
7. Provider 设置价格和 x402 payment config。
8. Registry 保存 manifest。
9. Validator 发起模拟请求。
10. Validator 校验响应格式。
11. 服务状态从 `pending` 变为 `verified` 或 `failed`。

### 6.2 Consumer Discovery

0. 用户已为主 Agent 接入 Discovery Connector。
1. Consumer Agent 将用户任务转成搜索 query。
2. Consumer Agent 调用 `search_services`。
3. Discovery Connector 查询 Registry。
4. Registry 返回候选服务。
5. Consumer Agent 调用 `get_manifest` 读取 manifest。
6. Consumer Agent 检查：
   - 能力是否匹配
   - 输入参数是否能构造
   - 输出字段是否足够
   - 样本响应是否合理
   - 价格是否在预算内
   - provider trust signal 是否可接受

### 6.3 Paid Invocation

1. Consumer Agent 调用 Discovery Connector 的 `invoke_paid_service`。
2. Discovery Connector 调用服务 endpoint。
3. 服务返回 HTTP 402 payment required。
4. Discovery Connector 或 Consumer Agent 根据 x402 要求完成支付。
5. Discovery Connector 带 payment proof 重试请求。
6. 服务验证支付。
7. 服务执行真实数据查询。
8. 服务返回 `agent_data_envelope_v1`。
9. Consumer Agent 解析数据并继续任务。
10. Consumer Agent、Discovery Connector 或 Registry 记录调用结果和反馈。

## 7. 功能需求

### 7.1 Service Manifest

每个服务必须提供 manifest。

MVP 字段：

```json
{
  "manifest_version": "agent_data_service_manifest_v1",
  "service_id": "chain_fund_flow_7d_base",
  "provider": {
    "provider_id": "provider_bob",
    "agent_identity": {
      "standard": "erc-8004-compatible",
      "agent_registry": "optional",
      "agent_id": "optional",
      "agent_uri": "optional"
    }
  },
  "title": "Base 7D Fund Flow",
  "description_for_agent": "Use this service to fetch recent fund flow metrics for Base.",
  "capabilities": ["onchain_data", "fund_flow", "stablecoin_flow"],
  "not_for": ["CEX order book data", "token price prediction"],
  "input_schema": {},
  "output_schema": {},
  "sample_request": {},
  "sample_response": {},
  "pricing": {
    "amount": "0.01",
    "currency": "USDC",
    "network": "base",
    "protocol": "x402"
  },
  "endpoint": {
    "url": "https://provider.example.com/services/chain-fund-flow",
    "method": "POST"
  },
  "data_source_claim": {
    "source_type": "api_wrapper",
    "authorization_status": "provider_declared",
    "redistribution_status": "provider_declared"
  },
  "freshness": {
    "update_frequency": "hourly",
    "max_data_lag_seconds": 7200
  }
}
```

### 7.2 Provider Wrapper

MVP 至少支持一种 wrapper，建议先做 HTTP API wrapper。

如果时间允许，增加 CLI wrapper。

最低要求：

- 接收标准 HTTP 请求。
- 将请求参数映射到底层数据能力。
- 保护底层 API key / token。
- 返回统一格式。
- 未付款时返回 x402 payment required。

### 7.3 Registry Search

MVP 支持简单搜索即可。

支持：

- keyword search
- capability filter
- chain filter
- verified only filter
- max price filter

返回：

- service_id
- title
- description_for_agent
- capabilities
- price
- sample_response
- verification_status
- provider trust summary

### 7.4 Discovery Connector

Discovery Connector 是 MVP 必须实现的需求侧入口。

最低要求：

- 可以被至少一种主 Agent 环境调用。
- 能把自然语言 query 转成 registry search 请求。
- 能返回候选服务列表。
- 能读取服务 manifest。
- 能返回样本响应。
- 能触发 paid invocation。
- 能把最终 `agent_data_envelope_v1` 返回给主 Agent。
- 能处理预算限制。

MVP 工具定义：

```json
[
  {
    "name": "search_services",
    "input": {
      "query": "string",
      "capabilities": "string[]",
      "max_price": "string",
      "verified_only": "boolean"
    }
  },
  {
    "name": "get_manifest",
    "input": {
      "service_id": "string"
    }
  },
  {
    "name": "preview_service",
    "input": {
      "service_id": "string",
      "input": {}
    }
  },
  {
    "name": "invoke_paid_service",
    "input": {
      "service_id": "string",
      "input": {},
      "budget": {
        "max_amount": "string",
        "currency": "USDC"
      }
    }
  }
]
```

### 7.5 Sample Room

未付费前，Consumer Agent 可以查看样本响应。

样本响应要求：

- 字段结构必须和真实响应兼容。
- 必须标记 sample 类型：mock、historical、truncated、redacted。
- 不能伪装成实时真实数据。
- 必须足够让 Agent 判断输出是否可用。

### 7.6 Schema Validation

接入验证器必须检查：

- endpoint 可访问
- sample_request 可执行
- response 是合法 JSON
- response 符合 output_schema
- 必填 metadata 存在
- 错误响应符合统一错误格式

### 7.7 x402 Payment

MVP 要求：

- Provider endpoint 能返回 HTTP 402。
- Discovery Connector 或 Consumer Agent 能解析 payment requirements。
- Discovery Connector 或 Consumer Agent 能完成支付。
- Provider 能验证支付。
- 成功支付后返回真实结果。

### 7.8 ERC-8004 Compatibility

MVP 要求尽量兼容 ERC-8004，但不阻塞核心流程。

最低实现：

- Provider 可以填写 ERC-8004 agent identity 信息。
- Manifest 中保留 `agent_registry`、`agent_id`、`agent_uri` 字段。
- Registry 可以展示该身份。
- 调用完成后生成 feedback event。

可选实现：

- Provider 实际注册 ERC-8004 identity。
- Manifest URL 写入 agent registration file。
- 调用反馈写入 reputation registry。
- 高价值调用接入 validation registry。

### 7.9 Agent-friendly Response

真实数据返回统一使用 `agent_data_envelope_v1`。

```json
{
  "schema_version": "agent_data_envelope_v1",
  "service_id": "chain_fund_flow_7d_base",
  "request_id": "req_abc123",
  "status": "success",
  "query": {},
  "data": {},
  "metadata": {
    "data_sources": [],
    "generated_at": "2026-05-16T12:00:00Z",
    "freshness_seconds": 3600,
    "is_estimated": false,
    "confidence": 0.8,
    "limitations": []
  },
  "agent_hints": {
    "good_for": [],
    "warnings": [],
    "suggested_followups": []
  },
  "summary": "Human-readable one paragraph summary."
}
```

错误响应：

```json
{
  "schema_version": "agent_data_envelope_v1",
  "service_id": "chain_fund_flow_7d_base",
  "request_id": "req_abc123",
  "status": "error",
  "error": {
    "code": "UNSUPPORTED_INPUT",
    "message": "The requested chain is not supported.",
    "retryable": false,
    "suggested_action": "Choose one of: base, ethereum, arbitrum."
  }
}
```

### 7.10 Feedback Event

每次调用后生成一个 feedback event。

MVP 字段：

```json
{
  "event_version": "agent_service_feedback_v1",
  "request_id": "req_abc123",
  "service_id": "chain_fund_flow_7d_base",
  "provider_id": "provider_bob",
  "consumer_id": "consumer_agent_123",
  "payment_tx": "0x...",
  "status": "success",
  "schema_valid": true,
  "latency_ms": 1800,
  "consumer_rating": 1,
  "created_at": "2026-05-16T12:00:00Z"
}
```

MVP 中 feedback 可以先存在本地数据库。后续再映射到 ERC-8004 reputation registry。

## 8. MVP 技术架构

### 8.1 组件

- Registry API
- Discovery Connector
- Provider Wrapper API
- Validator Worker
- Consumer Agent Demo Script
- x402 Payment Middleware / Client
- Metadata Store
- Feedback Store

### 8.2 最小数据存储

可以先用 SQLite / Postgres。

表：

- providers
- services
- manifests
- validation_runs
- invocation_logs
- feedback_events

### 8.3 推荐实现路径

优先级：

1. Registry API
2. Discovery Connector
3. Service manifest schema
4. Mock provider service
5. Validator schema check
6. x402 paywall
7. Consumer agent demo
8. Real chain data provider
9. ERC-8004 metadata compatibility

## 9. Demo 验收场景

### 9.1 Provider 侧

Bob 接入一个 `Base 7D Fund Flow` 服务。

验收：

- Bob 可以提交 manifest。
- Registry 保存服务。
- Validator 模拟请求成功。
- 服务状态显示为 `verified`。
- 样本响应可被查看。
- Provider endpoint 未付款时返回 HTTP 402。

### 9.2 Consumer 侧

用户向主 Agent 提出：

> 帮我分析 Base 链过去 7 天资金流向。

验收：

- 用户已为主 Agent 接入 Discovery Connector。
- Consumer Agent 搜索到 Bob 的服务。
- Consumer Agent 读取 manifest。
- Consumer Agent 判断样本响应字段可用。
- Consumer Agent 通过 x402 支付。
- Consumer Agent 获取真实结构化数据。
- Consumer Agent 输出一段基于数据的分析。
- 系统生成 feedback event。

## 10. 成功指标

### 10.1 技术成功指标

- 服务注册到可发现小于 1 分钟。
- Validator 能识别格式错误服务。
- Consumer Agent 能通过 Discovery Connector，在无人为具体数据源手动配置 API key 的情况下完成调用。
- x402 支付成功率达到 demo 可接受水平。
- 真实响应 100% 符合 `agent_data_envelope_v1`。

### 10.2 产品成功指标

- 至少 1 个真实数据服务完成接入。
- 至少 1 个 Consumer Agent 完成端到端调用。
- 付费前样本响应足以让 Agent 判断是否值得购买。
- 调用结果足以支持主 Agent 完成用户任务。

## 11. 风险与取舍

### 11.1 二房东供给风险

MVP 可以允许 community-hosted services 存在，但必须避免把“绕过订阅”作为官方卖点。

MVP 处理方式：

- Manifest 保留 `data_source_claim` 元数据，用于机器可读标记。
- MVP 不增加“我确认拥有授权 / 我接受责任”这类发布勾选或阻塞式声明。
- 官方可以展示 source claim / risk label，但不在 MVP 阶段做强审核。
- 默认不承诺上游数据合规性。
- 样本和 manifest 中标明 source claim。

### 11.2 ERC-8004 集成过重

完整 ERC-8004 集成可能拖慢 MVP。

MVP 处理方式：

- 先做到 metadata compatibility。
- 保留 agent identity 字段。
- feedback event 先 off-chain。
- 后续再链上写入 reputation registry。

### 11.3 数据真实性无法验证

MVP Validator 只验证格式，不验证真实性。

MVP 处理方式：

- 明确标记 validation scope。
- 返回 metadata 和 limitations。
- 后续引入多源交叉验证或 ERC-8004 validation registry。

### 11.4 x402 集成复杂度

如果 x402 SDK 或 facilitator 接入阻塞，MVP 可能延期。

MVP 处理方式：

- 第一阶段可以用 mock payment proof 跑通业务流程。
- 第二阶段替换为真实 x402。
- Demo 必须至少完成一次真实小额支付。

## 12. 两周实施计划

### Week 1

- Day 1：确定 manifest schema 和 response envelope。
- Day 2：实现 Registry API。
- Day 3：实现 Discovery Connector 的 `search_services` 和 `get_manifest`。
- Day 4：实现 mock Provider Wrapper 和 Validator Worker。
- Day 5：实现 Consumer Agent discovery + preview 流程。

### Week 2

- Day 6：接入 x402 payment middleware。
- Day 7：完成 paid invocation。
- Day 8：接入一个真实链上数据源或半真实 fixture。
- Day 9：增加 feedback event 和 ERC-8004 metadata 字段。
- Day 10：端到端 demo、修 bug、录屏和整理说明。

## 13. MVP 一句话

MVP 要证明的不是“我们能做一个完整市场”，而是：

> 一个 Agent 通过一次性接入的 Discovery Connector，能发现一个陌生数据服务，理解它能提供什么，看样本后决定付费，通过 x402 买到真实结构化数据，并把这次交互沉淀为后续信任信号。
