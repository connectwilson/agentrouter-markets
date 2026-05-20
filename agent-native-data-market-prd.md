# Agent Native Data Network PRD

## 1. 背景

当用户向自己的个人 Agent 提出“帮我分析 XX 链过去 7 天的链上资金流向”这类需求时，个人 Agent 具备上下文记忆、推理能力和对用户偏好的理解，但它通常缺少实时、专有或需要凭证的数据访问能力。

现有路径通常依赖用户自己寻找并安装某个数据服务的 MCP server 或 skill，并手动申请、配置 API key。这个流程对人类开发者尚可接受，但对普通用户和自主 Agent 都有明显摩擦：

- 用户需要知道哪个数据服务可用。
- 用户需要自己搜索、安装、配置工具。
- 用户需要注册账号、申请 API key、管理额度和费用。
- Agent 本身无法自主发现服务，也无法自主完成付费。

本项目希望验证一个更 Agent-native 的路径：

> 用户只需为主 Agent 接入一次通用 discovery connector，主 Agent 就能在任务执行过程中发现可用的专业数据服务，通过 x402 micropayment 按次付费调用，无需用户为每个数据源分别安装工具、订阅账号或配置 API key。

## 2. 产品定位

本产品不是一个面向人类浏览和挑选的通用 Agent 市场，也不是替代 Nansen、Dune、Arkham 等垂直数据服务。

更准确的定位是：

> 面向 Agent 的通用数据能力网络，把需要账号、API key、订阅、本地配置或专门接入的数据服务，封装成 Agent 可以发现、按次付费、直接调用的原子能力。

长期来看，本网络可以承载任意行业和维度的数据服务，例如链上数据、金融行情、舆情数据、企业数据库、行业报告、招聘数据、电商数据、科研数据、地理数据等。MVP 阶段先从链上数据切入，因为该场景需求高频、用户天然有钱包、付费意愿明确，且非常适合 x402 micropayment。

核心价值不在于“提供更强的推理”，而在于为个人 Agent 提供其不擅长的外部能力：

- 实时数据获取
- 链上查询或其他行业数据查询
- 第三方 API 调用
- 按次支付
- 标准化服务发现
- 可验证的返回结果

## 3. 目标用户

### 3.1 需求侧用户

主要不是直接面向普通人类用户，而是面向用户的个人 Agent、研究 Agent、交易 Agent 或自动化工作流。

典型需求：

- “查询过去 7 天 Base 链资金流入流出情况。”
- “获取某条链稳定币净流入数据。”
- “分析最近一周大户是否在增持某个代币。”
- “对比 Solana、Base、Arbitrum 的链上活跃资金趋势。”
- “获取某公司过去 30 天新闻舆情变化。”
- “查询某行业最近一个季度融资事件。”
- “拉取某电商平台某类商品的价格区间和销量趋势。”

需求侧 Agent 的核心诉求：

- 不想提前安装每个数据服务的 MCP / skill，只愿意接入一次通用发现入口。
- 不想让用户手动申请 API key。
- 希望按任务临时购买数据，而不是承担长期订阅。
- 希望获得结构化、可信、可继续推理的数据结果。

### 3.2 供给侧用户

拥有数据源访问能力的服务方或 Agent 开发者。

例如：

- 已持有 Nansen API key 的数据 Agent
- 已接入 Dune API 的查询 Agent
- 已聚合多个链上数据源的分析服务
- 自建 indexer / dashboard / 数据仓库的开发者
- 已经安装并配置好某个 CLI / skill / MCP server 的开发者
- 拥有行业数据库、私有数据集或垂直数据采集能力的团队

供给侧诉求：

- 将已有 API key、查询能力或数据资产变现。
- 不暴露自己的底层 API key。
- 按调用次数收取 micropayment。
- 通过标准服务描述被需求侧 Agent 发现。
- 用最小接入成本把已有 API、CLI、skill、MCP server 或数据库包装成远程服务。

## 4. 核心问题

当前 MCP / skill 生态解决了“Agent 如何调用工具”的一部分问题，但没有完整解决 Agent 原生消费外部能力的链条。

| 问题 | 当前状态 | 本项目目标 |
| --- | --- | --- |
| Agent 如何知道某个数据服务存在 | 主要靠人类搜索 | 通过一次性接入的 discovery connector 查询市场/注册表 |
| Agent 如何安装或连接服务 | 主要靠人类逐个配置 | 只安装一次通用入口，后续远程调用具体服务 |
| 谁来提供 API key | 用户或开发者提前配置 | 供给侧 Agent 自带凭证 |
| 谁来付钱 | 用户订阅或开发者账号承担 | 需求侧 Agent 按次 x402 支付 |
| Agent 能否自主决定是否购买 | 基本不能 | 可以根据任务需要自主决策 |
| 返回结果能否被后续推理使用 | 取决于工具实现 | 强制结构化返回 |

因此，本项目要验证的不是“Agent 能不能拿到链上数据”，也不是“Agent 能否在没有任何入口的情况下凭空发现网络”，而是：

> 一个主 Agent 在接入一次通用 discovery connector 后，能否在没有用户逐个安装服务、配置 API key 的情况下，发现并调用专业数据 Agent，通过 micropayment 获取足够可信的链上数据，然后继续完成自己的研究任务。

更一般地说，本项目要验证的是：

> 数据消费主体能否从“人类开发者提前申请、安装、配置、付费”变成“Agent 在任务过程中发现、判断、付费、调用”。

## 5. 价值主张

### 5.1 对需求侧 Agent

从：

1. 用户搜索数据源
2. 安装 MCP server / skill
3. 注册账号
4. 申请 API key
5. 配置环境变量
6. 重启客户端
7. 测试调用
8. Agent 才能使用

变成：

1. 用户为主 Agent 接入一次通用 discovery connector
2. Agent 查询市场
3. Agent 选择合适的数据服务
4. Agent 支付一笔小额 USDC
5. 数据返回

核心优势：

- 一次接入，而不是为每个服务单独安装
- 无需为每个数据源注册账号
- 无需为每个数据源配置 API key
- 无需为低频需求订阅完整产品
- 按次付费
- Agent 可以在任务过程中自主完成发现、判断、支付和调用

### 5.1.1 Discovery Connector

Discovery connector 是主 Agent 进入本网络的最小 bootstrap 入口。

它可以有多种形态：

- MCP server：适合 Claude、Cursor、支持 MCP 的 Agent 客户端。
- Skill / plugin：适合有自定义工具系统的 Agent 环境。
- CLI：适合 Codex 或本地 coding agent 通过 shell 调用。
- Hosted HTTP API：适合已经具备联网和自定义工具调用能力的 Agent。

Discovery connector 至少提供以下能力：

- `search_services(query, filters)`：搜索服务。
- `get_manifest(service_id)`：读取服务 manifest。
- `preview_service(service_id, input)`：查看样本响应。
- `invoke_paid_service(service_id, input, budget)`：触发 x402 付费调用。
- `get_feedback(service_id)`：读取基础信誉和调用记录。

这意味着本产品的真实承诺不是“完全零安装”，而是：

> 一次接入，发现并调用网络内所有数据服务；无需为每个服务分别安装、注册和配置。

原始路径仍然是：

1. 用户搜索数据源
2. 安装某个数据源的 MCP server / skill
3. 注册账号
4. 申请 API key
5. 配置环境变量
6. 重启客户端
7. 测试调用
8. Agent 才能使用

新路径是：

1. 用户安装一次 discovery connector
2. Agent 选择合适的数据服务
3. Agent 支付一笔小额 USDC
4. 数据返回

### 5.2 对供给侧 Agent

供给侧可以把自己已经接入的数据能力包装成可售卖的远程服务。底层能力可以来自：

- API key：供给方已经拥有某个数据 API 的访问权限，对外封装成有限能力。
- CLI：供给方已经能通过命令行工具查询数据，将 CLI 调用包装成网络服务。
- Skill / MCP server：供给方已经安装并配置好某个 agent tool，将其作为后端能力暴露。
- 数据库 / 文件 / indexer：供给方拥有自建数据资产或同步好的数据仓库。
- 人工维护数据集：供给方维护行业名单、地址标签、项目库、报告库等结构化数据。

供给侧对外不暴露底层 API key、账号、CLI token 或数据库凭证，只暴露标准服务接口。每次调用前要求 x402 payment，调用成功后返回结构化数据，收益按次结算。

### 5.3 对平台

平台的核心资产不是模型能力，而是：

- 服务发现网络
- 标准服务描述
- 支付和结算协议
- 服务质量与信誉体系
- 垂直领域的数据能力供给

## 6. MVP 场景

### 6.1 示例任务

用户向主 Agent 提出：

> 帮我分析 Base 链过去 7 天的链上资金流向。

主 Agent 执行流程：

1. 判断任务需要实时链上数据。
2. 通过 discovery connector 向 Agent-native data market 查询可用服务。
3. 发现一个 `chain_fund_flow_7d` 数据 Agent。
4. 获取服务描述、价格、输入参数和返回格式。
5. 判断价格可接受。
6. 发起 x402 payment。
7. 调用数据 Agent。
8. 获取结构化数据。
9. 基于数据继续分析，给用户输出判断。

### 6.2 MVP 不做什么

MVP 阶段不做：

- 通用 Agent 市场
- Token 激励
- 复杂仲裁系统
- 多数据源自动竞价
- 完整信誉体系
- 自动交易执行
- 面向普通用户的复杂 UI

MVP 只验证一个闭环：

> 主 Agent 通过 discovery connector 发现数据服务 -> x402 付费 -> 数据 Agent 返回结果 -> 主 Agent 继续推理。

## 7. 功能需求

### 7.1 服务注册

供给侧数据 Agent 需要能注册一个服务描述。

服务描述至少包括：

- 服务名称
- 服务能力描述
- 输入参数 schema
- 输出结果 schema
- 支持链
- 数据时间范围
- 数据源说明
- 价格
- x402 支付地址或支付配置
- 服务端点
- SLA / 超时说明
- 数据来源/授权状态元数据
- 样本请求和样本响应
- 是否支持免费 preview / paid full result
- 接入方式类型：API、CLI、skill、MCP、database、manual dataset

示例：

```json
{
  "service_id": "chain_fund_flow_7d_base",
  "name": "Base 7D Fund Flow Data",
  "description": "Return 7-day on-chain fund flow data for Base, including inflow, outflow, stablecoin movement, bridge flow and top protocol changes.",
  "inputs": {
    "chain": "base",
    "days": 7
  },
  "outputs": {
    "net_flow_usd": "number",
    "inflow_usd": "number",
    "outflow_usd": "number",
    "stablecoin_net_flow_usd": "number",
    "top_sources": "array",
    "top_destinations": "array",
    "data_source": "string",
    "generated_at": "string"
  },
  "price": {
    "amount": "0.001",
    "currency": "USDC",
    "network": "base"
  }
}
```

### 7.2 数据方接入方式

供给侧需要能用低成本把已有数据能力接入网络。MVP 阶段不要求供给方重写自己的数据系统，而是提供一个轻量 wrapper 模型。

支持的接入方式：

- **HTTP API wrapper**：供给方填写上游 API endpoint、鉴权方式、参数映射和返回 schema。
- **CLI wrapper**：供给方把本地 CLI 命令包装成服务，网络请求映射为命令参数，命令输出被解析为 JSON。
- **Skill / MCP wrapper**：供给方把已安装、已配置的 skill 或 MCP server 包装为远程能力。
- **Database wrapper**：供给方连接自己的数据库或数据仓库，暴露有限查询能力。
- **Static dataset wrapper**：供给方上传或挂载结构化数据集，按查询参数返回结果。

无论底层是哪种方式，对需求侧 Agent 暴露的都应该是统一接口：

```json
{
  "service_id": "string",
  "operation": "string",
  "input": {},
  "payment": {},
  "response_format": "agent_data_envelope_v1"
}
```

平台需要明确区分“开放协议接入”和“官方市场背书”：

- 协议层允许任何人接入服务。
- 官方市场可以对服务进行风险分层、排序和标注。
- 服务 manifest 可以展示数据来源、授权状态和再分发状态等 provider-declared 元数据。
- MVP 可以允许 community-hosted services 存在，但官方默认推荐来源透明、格式稳定、风险较低的服务。

### 7.3 服务目录 / Manifest

每个数据服务必须提供一个机器可读的服务目录，也可以叫 service manifest。这个目录的目标读者不是人，而是需求侧 Agent。

Manifest 需要回答：

- 这个服务能提供哪些数据？
- 适合解决哪些任务？
- 不适合解决哪些任务？
- 支持哪些参数？
- 返回哪些字段？
- 字段含义是什么？
- 数据来源是什么？
- 数据更新频率是什么？
- 价格是多少？
- 是否有样本响应？
- 付费后会比样本多返回什么？
- 调用失败时可能有哪些错误？

Manifest 最低字段：

```json
{
  "service_id": "chain_fund_flow",
  "provider_id": "provider_123",
  "title": "Chain Fund Flow Data",
  "capabilities": [
    "fund_flow",
    "stablecoin_flow",
    "bridge_flow"
  ],
  "description_for_agent": "Use this service when you need recent fund flow data for an EVM chain. It returns structured inflow, outflow, net flow, stablecoin movement and top counterparties.",
  "not_for": [
    "historical data older than 90 days",
    "off-chain CEX order book data"
  ],
  "input_schema": {},
  "output_schema": {},
  "sample_request": {},
  "sample_response": {},
  "pricing": {},
  "freshness": {
    "update_frequency": "hourly",
    "max_data_lag_seconds": 7200
  },
  "authorization_claim": {
    "source_type": "api_wrapper",
    "redistribution_status": "provider_declared"
  }
}
```

### 7.4 服务发现

主 Agent 需要能根据自然语言任务或结构化需求查询服务。

主 Agent 并不会天然知道本网络存在，因此查询能力必须通过 discovery connector 暴露给主 Agent。

最低要求：

- 支持关键词搜索，例如 `chain fund flow base 7d`
- 支持按能力标签过滤，例如 `onchain_data`、`fund_flow`、`base`
- 返回候选服务列表
- 每个候选服务包含价格、能力、返回格式和可信度信息

### 7.5 服务接入验证与样本间

供给方接入服务后，平台需要自动模拟一次或多次请求，验证服务是否能按 manifest 声明的 schema 返回结果。

验证目标不是证明数据一定真实，而是证明：

- 服务 endpoint 可访问。
- 输入参数 schema 可被正确处理。
- 返回结果是合法 JSON。
- 返回结构符合 output schema。
- 必填字段存在。
- 错误码格式符合规范。
- 样本响应可以被需求侧 Agent 理解。

MVP 阶段可以引入“样本间”机制：

- 未付费前，需求侧 Agent 可以看到 manifest、字段说明、价格、样本请求和样本响应。
- 样本响应可以是脱敏数据、历史数据、mock 数据或截断数据。
- 样本响应必须结构真实，字段含义真实，但不要求是当前最新数据。
- 付费后才返回完整、实时或高价值数据。

这能让需求侧 Agent 在付款前判断服务是否满足任务需要，降低盲付风险。

### 7.6 x402 支付

需求侧 Agent 调用付费服务并获取完整结果前，需要完成 x402 payment。

最低要求：

- 服务方能返回 payment required response
- 需求侧 Agent 能识别价格和支付要求
- 需求侧 Agent 能发起支付
- 服务方能验证支付
- 支付成功后返回数据

MVP 可先使用测试网或小额 Base USDC。

### 7.7 Agent-friendly 数据返回格式

数据方返回给需求方的结果必须对 Agent 友好，而不是只返回人类可读文本。推荐统一使用 `agent_data_envelope_v1`。

设计原则：

- 结构化优先：JSON 优先于自然语言段落。
- 字段自解释：关键字段需要有单位、时间范围和含义。
- 可追溯：包含数据来源、生成时间、查询参数。
- 可判断：包含置信度、数据新鲜度、是否估算、缺失字段。
- 可组合：便于主 Agent 继续传给其他 Agent 或用于后续计算。
- 人类摘要可选：可以附带 summary，但不能只有 summary。

推荐返回格式：

```json
{
  "schema_version": "agent_data_envelope_v1",
  "service_id": "chain_fund_flow_7d_base",
  "request_id": "req_abc123",
  "status": "success",
  "query": {
    "chain": "base",
    "days": 7,
    "time_range": {
      "start": "2026-05-09T00:00:00Z",
      "end": "2026-05-16T00:00:00Z"
    }
  },
  "data": {
    "metrics": {
      "inflow_usd": 123000000,
      "outflow_usd": 98000000,
      "net_flow_usd": 25000000,
      "stablecoin_net_flow_usd": 18000000
    },
    "breakdowns": {
      "top_sources": [],
      "top_destinations": [],
      "top_protocol_changes": []
    }
  },
  "metadata": {
    "data_sources": ["provider_declared_source"],
    "generated_at": "2026-05-16T12:00:00Z",
    "freshness_seconds": 3600,
    "is_estimated": false,
    "confidence": 0.82,
    "limitations": []
  },
  "agent_hints": {
    "good_for": [
      "trend analysis",
      "chain comparison",
      "market research"
    ],
    "warnings": [
      "Do not treat net flow as direct buy/sell pressure without additional market context."
    ],
    "suggested_followups": [
      "Compare with stablecoin supply change",
      "Check exchange inflow/outflow"
    ]
  },
  "summary": "Base had a positive 7-day net flow, led by stablecoin inflows."
}
```

错误响应也必须结构化：

```json
{
  "schema_version": "agent_data_envelope_v1",
  "service_id": "chain_fund_flow_7d_base",
  "request_id": "req_abc123",
  "status": "error",
  "error": {
    "code": "UNSUPPORTED_CHAIN",
    "message": "This service does not support the requested chain.",
    "retryable": false,
    "suggested_action": "Choose one of: base, ethereum, arbitrum."
  }
}
```

### 7.8 数据 Agent

数据 Agent 在 MVP 中可以先包装一个真实或半真实数据源。

可选实现：

- Dune API wrapper
- Nansen API wrapper
- 自建 mock 数据 + 固定 schema
- 公开链上数据 API wrapper
- CLI / skill wrapper

优先级建议：

1. 先用 mock / fixture 跑通协议闭环。
2. 再接入真实 Dune 或 Nansen API。
3. 最后加入多数据源校验。

### 7.9 主 Agent

主 Agent 需要具备以下能力：

- 理解用户任务需要外部数据
- 通过 discovery connector 查询市场发现数据 Agent
- 读取服务 manifest
- 基于样本响应判断服务是否可能满足需求
- 判断是否值得付费
- 完成 x402 调用
- 解析结构化返回
- 将数据转化为自然语言分析

MVP 中主 Agent 可以是一个脚本或简单 agent loop，不需要复杂产品 UI。

## 8. 非功能需求

### 8.1 可验证性

返回数据必须包含：

- 数据源
- 查询时间
- 查询参数
- 时间范围
- 原始关键指标
- 是否为估算值
- 数据新鲜度
- 字段单位
- 已知限制
- 置信度或服务方声明的质量标记

### 8.2 可组合性

返回结果必须是结构化 JSON，方便主 Agent 后续继续调用其他 Agent 或进行推理。

结构化结果需要同时支持两类消费：

- 机器消费：主 Agent 可以稳定读取字段、继续计算、传递给其他服务。
- 人类解释：主 Agent 可以把 summary、limitations、warnings 转化为最终回答的一部分。

### 8.3 成本可控

主 Agent 需要有支付策略：

- 单次最大支付金额
- 单任务最大预算
- 是否需要用户确认
- 可接受的数据新鲜度

### 8.4 失败处理

需要处理：

- 服务不存在
- 价格过高
- 支付失败
- 数据 Agent 超时
- 返回格式不符合 schema
- 数据为空或质量不足
- 样本响应与付费响应结构不一致
- manifest 描述与实际能力不一致

## 9. 验收标准

MVP 验收以一个完整 demo 为准。

### 9.1 基础验收

给定任务：

> 分析 Base 链过去 7 天资金流向。

系统能够：

- 主 Agent 判断需要链上数据。
- 主 Agent 通过 discovery connector 查询市场并找到合适的数据 Agent。
- 主 Agent 获取服务 manifest、样本响应和价格。
- 平台已对该服务进行模拟请求，验证返回格式符合 schema。
- 主 Agent 通过 x402 完成小额支付。
- 数据 Agent 验证支付并返回结构化数据。
- 主 Agent 基于数据输出分析结论。

### 9.2 输出验收

最终输出需要包含：

- 过去 7 天净流入/净流出
- 主要流入来源
- 主要流出目的地
- 稳定币流向
- 主要协议或地址变化
- 对链上资金状态的解释
- 数据来源和时间戳

### 9.3 产品假设验收

MVP 需要回答三个问题：

1. Agent 是否能在只接入一次 discovery connector 的情况下发现并调用数据服务？
2. x402 micropayment 是否能替代 API key / 订阅式访问？
3. 返回数据是否足够让主 Agent 完成后续分析？
4. 供给方是否能用低成本把已有 API、CLI、skill、MCP server 或数据集接入网络？
5. 样本响应是否足以帮助需求侧 Agent 在付款前判断服务是否值得调用？

## 10. 竞品与差异化

### 10.1 Nansen / Dune / Moralis

这些产品提供强大的链上数据能力，部分已经支持 MCP 或 Agent 接入。

但它们通常仍然默认：

- 人类用户注册账号
- 人类用户申请 API key
- 人类用户配置环境
- 用户或开发者承担订阅费用

本项目不和它们正面对抗，而是作为适配层：

> 把这些数据服务变成 Agent 可以按次购买的能力。

### 10.2 MCP Server / Skills

MCP 和 skills 解决的是工具连接问题，但通常不解决：

- 服务发现
- 自动安装
- API key 获取
- 按次付费
- Agent 自主经济决策

本项目可以兼容 MCP，但重点是补齐 discovery + payment。

如果某个供给方已经有 MCP server，本项目不要求其重做能力，而是可以把该 MCP server 包装成一个可发现、可付费、可远程调用的数据服务。

### 10.3 Fetch.ai / Agentverse / Virtuals / Bittensor

这些更偏通用 Agent 网络、AI 资产发行、模型/Agent 经济或 token 生态。

本项目 MVP 不做通用市场和 token 激励，而是聚焦一个更窄但更真实的需求：

> 币圈研究 Agent 按次购买链上数据。

差异化来自：

- 垂直链上数据场景
- 无需用户配置 API key
- x402 按次支付
- Agent 原生发现和调用
- 结构化结果可被继续推理

## 11. 关键风险与坑

### 11.1 数据质量验证难

链上数据是否正确不总是容易判断。不同数据源对资金流向、桥接、交易所地址、协议归属的定义可能不同。

缓解方式：

- 返回数据源和定义
- 保留查询参数
- 允许多数据源交叉验证
- 对关键指标给出置信度
- 初期聚焦少数明确指标

### 11.2 服务发现可能变成垃圾市场

如果任何供给方都能注册服务，市场容易出现低质量、重复、虚假服务。

缓解方式：

- MVP 阶段人工白名单
- 服务调用成功率统计
- schema 校验
- 数据样例审查
- 后续再做 reputation
- 将“开放接入”和“官方推荐”分层
- 对服务授权状态做显式标记

### 11.3 x402 支付体验和钱包管理

Agent 自主支付需要预算控制和安全边界，否则可能出现误付、重复付费或被恶意服务诱导消费。

缓解方式：

- 单次支付上限
- 单任务预算上限
- 白名单服务
- 首次调用需要用户确认
- 完整支付审计记录

### 11.4 合规风险

跨境 USDC micropayment、无账号体系、Agent 自主交易都存在监管不确定性。

缓解方式：

- MVP 仅作为技术验证
- 限制真实资金规模
- 优先使用测试网或极小金额
- 避免面向受限制地区公开运营
- 后续引入 KYC / KYB 或合规服务商

### 11.5 供给侧 API 条款风险

某些数据服务可能不允许转售、代理访问或二次商业化。

缓解方式：

- 优先使用允许商业 API wrapper 的数据源
- 检查 API terms
- 与数据源合作
- 初期使用自建 indexer 或公开数据
- 在 manifest 中保留数据来源和授权状态元数据
- 官方市场默认推荐低风险服务
- 对 community-hosted services 做风险标签，不把“绕过订阅”作为官方卖点

### 11.6 样本响应可能误导需求侧 Agent

样本响应如果过于理想化，可能让需求侧 Agent 误以为服务质量高于真实情况。

缓解方式：

- 样本响应必须使用真实 schema。
- 样本响应必须标记 sample、mock、historical、truncated 等类型。
- 付费响应必须保持与样本响应兼容的字段结构。
- 平台定期抽检样本响应和真实响应是否一致。

### 11.7 “Agent 自主发现”标准尚未成熟

目前没有统一的 Agent-native service discovery 标准。

缓解方式：

- MVP 先用简单 registry API
- 服务描述采用 JSON schema
- 保持可兼容 MCP / OpenAPI / x402 metadata
- 后续再标准化协议

## 12. 两周 POC 建议

### Week 1

- 定义服务描述 schema
- 定义 agent_data_envelope_v1 返回格式
- 实现简单 service registry
- 实现 service manifest
- 实现服务接入后的模拟请求和 schema 校验
- 实现一个数据 Agent mock
- 实现 x402 payment required / payment verification 流程
- 实现主 Agent 调用流程

### Week 2

- 接入一个真实链上数据源
- 增加结构化返回校验
- 增加预算控制
- 完成端到端 demo
- 准备一份 demo script 和录屏

## 13. 成功标准

POC 成功不以收入或用户规模衡量，而以是否证明以下闭环为准：

> 一个 Agent 在只接入一次通用 discovery connector、没有为具体服务预配置工具和 API key 的情况下，能够发现一个外部数据能力，通过小额支付完成调用，并用返回数据完成更高层任务。

如果这个闭环成立，后续可以扩展到：

- 多个链上数据 Agent
- 多行业数据服务
- 多数据源竞价
- 数据质量评分
- 服务 manifest 标准
- 样本响应和真实响应一致性检测
- Agent budget policy
- 服务 reputation
- 面向研究 Agent 的 API marketplace
- 更广义的 Agent-native paid capability network

## 14. 一句话总结

本项目的核心不是“再做一个 Agent 市场”，而是：

> 让 Agent 通过一次通用入口发现并购买任意外部数据能力，而不需要人类为每个服务分别安装、申请 API key 或配置账号；先从币圈链上数据这个高频、刚需、天然适合 USDC micropayment 的场景切入。
