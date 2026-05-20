# Arc Hackathon PRD: Agent Data Network on Arc

## 1. 项目一句话

Agent Data Network on Arc 是一个面向 AI Agent 的付费数据服务网络：Agent 可以发现数据服务、预览样本、用 Arc 上的 USDC 按次付款、获取真实结构化数据，并把调用凭证和服务信誉沉淀到链上。

## 2. 黑客松目标

本作品不追求完成完整数据市场，而是做出一个能打动评委的端到端 demo：

> Bob 发布一个数据服务 -> Alice 的 Agent 发现服务 -> Alice Agent 用 Arc USDC 付款 -> Bob 的 Provider Runtime 返回数据 -> 调用 receipt 和 feedback 写入 Arc。

核心展示点：

- Agent-native discovery
- Stablecoin-native pay-per-call
- Onchain receipts
- Provider reputation / feedback
- Off-chain data runtime + onchain settlement

## 3. 为什么适合 Arc

这个项目和 Arc 的结合点非常直接：

- Agent 调用数据服务是高频、小额、按次计费场景。
- 数据服务价格天然适合用美元计价。
- Arc 的 stablecoin-native 叙事适合 Agent micropayment。
- Arc EVM-compatible，方便快速部署 registry、receipt、feedback 合约。
- Agent 经济需要可审计的支付和信誉记录，而不是只存在平台数据库里。

一句话叙事：

> Arc becomes the settlement and trust layer for agent-to-agent data commerce.

## 4. 用户角色

### 4.1 Bob: Data Provider

Bob 拥有某种数据能力，例如：

- 自有数据集
- hosted HTTP 数据服务
- 上游 API wrapper
- 链上数据查询
- 行业数据源

Bob 希望把该能力发布成可被 Agent 调用的付费服务。

### 4.2 Alice: Data Consumer

Alice 使用 Claude / Codex / 自研 Agent 完成研究任务。

Alice 希望她的 Agent 可以：

- 搜索可用数据服务
- 查看 manifest 和 sample response
- 按次支付
- 获取真实数据
- 不需要为每个数据源单独申请 API key

### 4.3 Provider Runtime

Provider Runtime 是链下服务运行层。

职责：

- 接收 Agent 请求
- 返回 sample response
- 检查链上 payment receipt 或 x402 payment proof
- 调用上游数据源或本地数据源
- 返回 `agent_data_envelope_v1`

### 4.4 Arc Contracts

Arc 合约负责链上可信状态：

- 服务注册
- 价格和 provider 地址
- 支付 receipt
- response hash
- feedback
- 基础信誉统计

## 5. Demo 用户故事

### 5.1 Bob 发布服务

Bob 运行：

```bash
adn provider onboard --mode hosted-http --yes
adn arc register-service hosted_http_sentiment_demo
```

系统完成：

1. 生成 service manifest。
2. 生成 sample response。
3. Provider Runtime 准备好 endpoint。
4. 将 `serviceId`、`provider`、`price`、`manifestURI`、`manifestHash` 写入 Arc `ServiceRegistry` 合约。

### 5.2 Alice Agent 调用服务

Alice 对主 Agent 说：

> 帮我获取 ETH 最近 7 天社区情绪数据并总结。

Agent 执行：

1. 通过 Discovery Connector 搜索 `sentiment ETH 7d`。
2. 找到 Bob 的 `hosted_http_sentiment_demo`。
3. 读取 manifest 和 sample response。
4. 判断价格可接受。
5. 用 Alice Agent Wallet 在 Arc 上支付 USDC。
6. 生成 payment receipt。
7. 带 receipt 调用 Bob Provider Runtime。
8. 获取 `agent_data_envelope_v1`。
9. 输出分析。
10. 将 response hash 和 feedback 写入 Arc。

## 6. 端到端流程

```text
Bob Provider CLI
  -> create manifest
  -> register service on Arc

Alice Agent
  -> search service
  -> read manifest/sample
  -> pay service on Arc
  -> call Provider Runtime with payment receipt
  -> receive structured data
  -> submit feedback on Arc
```

## 7. MVP 范围

### 7.1 做什么

- 一个 off-chain Registry / Discovery Connector。
- 一个 Provider Runtime。
- 一个 demo hosted-http 数据服务。
- 一个 Alice local Agent Wallet。
- Arc `ServiceRegistry` 合约。
- Arc `AgentDataReceipts` 合约。
- CLI 命令：
  - `adn arc deploy`
  - `adn arc register-service <service_id>`
  - `adn arc pay <service_id>`
  - `adn arc receipt <request_id>`
  - `adn arc feedback <request_id>`
- Demo 页面或 CLI 输出展示：
  - service registered tx
  - payment tx
  - receipt tx
  - feedback tx
  - final Agent analysis

### 7.2 不做什么

- 不做完整去中心化 storage。
- 不做复杂仲裁。
- 不做多 provider 竞价。
- 不做 token 激励。
- 不做完整 reputation marketplace。
- 不做真实 Nansen / Dune 接入。
- 不做生产级 key vault。

## 8. 合约设计

### 8.1 ServiceRegistry.sol

目的：记录数据服务的链上公开索引。

字段：

```solidity
struct Service {
    bytes32 serviceId;
    address provider;
    address paymentToken;
    uint256 price;
    string manifestURI;
    bytes32 manifestHash;
    bool active;
}
```

函数：

```solidity
function registerService(
    bytes32 serviceId,
    address provider,
    address paymentToken,
    uint256 price,
    string calldata manifestURI,
    bytes32 manifestHash
) external;

function updateService(
    bytes32 serviceId,
    uint256 price,
    string calldata manifestURI,
    bytes32 manifestHash,
    bool active
) external;

function getService(bytes32 serviceId) external view returns (Service memory);
```

事件：

```solidity
event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, uint256 price, string manifestURI);
event ServiceUpdated(bytes32 indexed serviceId, uint256 price, bool active);
```

### 8.2 AgentDataReceipts.sol

目的：记录 Alice 对 Bob 服务的一次付费调用。

字段：

```solidity
struct Receipt {
    bytes32 requestId;
    bytes32 serviceId;
    address payer;
    address provider;
    uint256 amount;
    bytes32 responseHash;
    uint256 timestamp;
}
```

函数：

```solidity
function payAndRecord(
    bytes32 serviceId,
    bytes32 requestId
) external returns (bytes32 receiptId);

function attachResponseHash(
    bytes32 receiptId,
    bytes32 responseHash
) external;

function getReceipt(bytes32 receiptId) external view returns (Receipt memory);
```

事件：

```solidity
event ServicePaid(bytes32 indexed receiptId, bytes32 indexed serviceId, address indexed payer, address provider, uint256 amount);
event ResponseAttached(bytes32 indexed receiptId, bytes32 responseHash);
```

实现说明：

- `payAndRecord` 从 `ServiceRegistry` 读取 service price 和 provider。
- 使用 Arc 上的 USDC / ERC-20 `transferFrom` 完成付款。
- MVP 可以先要求 Alice 对 `AgentDataReceipts` 合约 approve 一定额度。
- `attachResponseHash` 可由 payer 或 provider 调用。

### 8.3 AgentFeedback.sol

目的：记录调用后的服务反馈。

字段：

```solidity
struct Feedback {
    bytes32 receiptId;
    uint8 rating;
    bool schemaValid;
    bytes32 commentHash;
    uint256 timestamp;
}
```

函数：

```solidity
function submitFeedback(
    bytes32 receiptId,
    uint8 rating,
    bool schemaValid,
    bytes32 commentHash
) external;

function getServiceStats(bytes32 serviceId) external view returns (
    uint256 feedbackCount,
    uint256 ratingSum,
    uint256 schemaValidCount
);
```

事件：

```solidity
event FeedbackSubmitted(bytes32 indexed receiptId, bytes32 indexed serviceId, uint8 rating, bool schemaValid);
```

MVP 可选：如果时间不够，可以把 feedback 合并进 `AgentDataReceipts`。

## 9. Off-chain 组件

### 9.1 Discovery Connector

沿用当前 MVP。

新增能力：

- 查询本地 registry。
- 可选读取 Arc `ServiceRegistry`。
- 返回链上 service 状态：
  - provider address
  - price
  - manifest hash
  - active status

### 9.2 Provider Runtime

沿用当前 MVP 的 hosted-http runtime。

新增能力：

- 验证 Alice 提供的 Arc receipt。
- 检查 receipt 是否对应当前 service。
- 检查 payer 是否已付款。
- 返回数据后计算 response hash。

### 9.3 Alice Wallet

沿用当前 MVP 的 local Agent Wallet 概念。

黑客松版本可选：

- 方案 A：用私钥本地签 Arc transaction。
- 方案 B：用浏览器钱包 / test wallet 手动签。
- 方案 C：先由 CLI 使用测试私钥自动签。

建议黑客松用方案 C，减少 demo 摩擦。

## 10. CLI 设计

### 10.1 Deploy

```bash
adn arc deploy
```

输出：

```json
{
  "serviceRegistry": "0x...",
  "agentDataReceipts": "0x...",
  "agentFeedback": "0x..."
}
```

### 10.2 Register Service

```bash
adn arc register-service hosted_http_sentiment_demo
```

读取：

```text
providers/hosted_http_sentiment_demo.json
```

写入 Arc：

- serviceId
- provider address
- price
- manifestURI
- manifestHash

### 10.3 Pay

```bash
adn arc pay hosted_http_sentiment_demo '{"asset":"ETH","window":"7d"}'
```

执行：

1. 从 Arc 读取 service。
2. Alice approve / pay。
3. 调用 `payAndRecord`。
4. 得到 `receiptId`。
5. 调 Provider Runtime。
6. 计算 response hash。
7. attach response hash。

### 10.4 Feedback

```bash
adn arc feedback <receipt_id> --rating 1 --schema-valid true
```

写入 `AgentFeedback`。

## 11. Demo 脚本

### 11.1 Setup

```bash
npm start
adn wallet init
adn provider onboard --mode hosted-http --yes
adn arc deploy
adn arc register-service hosted_http_sentiment_demo
```

### 11.2 Agent Request

用户说：

> Get ETH 7-day community sentiment and summarize it.

Agent 执行：

```bash
adn search "ETH sentiment 7d"
adn preview hosted_http_sentiment_demo
adn arc pay hosted_http_sentiment_demo '{"asset":"ETH","window":"7d"}'
adn arc feedback <receipt_id> --rating 1 --schema-valid true
```

输出：

```text
ETH sentiment is positive over the past 7 days, with score 0.79...

Arc service registration tx: 0x...
Arc payment tx: 0x...
Arc receipt id: 0x...
Arc feedback tx: 0x...
```

## 12. 评委视角亮点

### 12.1 Agent Commerce

不是人手动买 API，而是 Agent 在任务中发现并购买数据能力。

### 12.2 Stablecoin-native Settlement

每次调用都是 Arc 上的 USDC 结算，价格以美元计价。

### 12.3 Onchain Trust

支付、调用、response hash、feedback 都有链上记录，服务方信誉可以累积。

### 12.4 Open Provider Network

任何人都能发布 provider-declared data service，先从 hosted-http 降低接入门槛。

### 12.5 Off-chain Data, Onchain Receipts

数据本身不必上链，避免昂贵和隐私问题；链上只记录最小可信凭证。

## 13. 成功标准

黑客松 demo 成功标准：

- Bob 服务成功注册到 Arc。
- Alice Agent 能发现服务。
- Alice Agent 能预览 sample。
- Alice Agent 能在 Arc 上完成 USDC 付款。
- Provider Runtime 能基于 receipt 返回数据。
- response hash 写入 Arc。
- feedback 写入 Arc。
- 最终输出一段 Agent 生成的数据分析。

## 14. 风险与取舍

### 14.1 真实 x402 vs 合约支付

如果真实 x402 接入时间不够，黑客松可以先用 Arc 合约 `payAndRecord` 实现 pay-per-call，再把 x402 作为兼容方向。

### 14.2 数据真实性

MVP 不证明数据真实，只证明：

- 服务被注册
- 调用被付款
- 返回结构符合 schema
- response hash 可追溯
- feedback 可累积

### 14.3 Provider Secret

黑客松版本可以继续使用本地 provider config 模拟 secret vault。不要把 secret 写入 manifest 或链上。

### 14.4 链上 discovery

MVP 可以 off-chain search + onchain registry 双轨：

- off-chain registry 用于关键词/semantic discovery
- Arc contract 用于支付、服务状态和 trust record

## 15. 最小实现路线

### Day 1

- 写 Solidity 合约。
- 本地 Hardhat / Foundry 测试。
- CLI 部署合约。

### Day 2

- `adn arc register-service`
- manifest hash 计算。
- service 写入 Arc。

### Day 3

- `adn arc pay`
- Alice 测试钱包付款。
- Provider Runtime receipt 校验。

### Day 4

- response hash attach。
- feedback 合约。
- CLI 输出 demo receipt。

### Day 5

- 录屏、README、demo polish。

## 16. 最终 pitch

> We built an agent-native paid data network on Arc. AI agents can discover data services, preview samples, pay per call in USDC, receive structured data, and build onchain trust histories for providers.

中文：

> 我们在 Arc 上做了一个 Agent 原生付费数据网络。AI Agent 可以发现数据服务、预览样本、用 USDC 按次付款、获取结构化数据，并把支付凭证和服务信誉沉淀到链上。
