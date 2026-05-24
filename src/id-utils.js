export function normalizeId(rawId, fallback, prefix) {
  const base = String(rawId || fallback || prefix)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 56);
  const normalized = base || prefix;
  return normalized.length >= 3 ? normalized : `${prefix}_${normalized}`;
}

export function suggestCapabilities(text) {
  const value = String(text || "").toLowerCase();
  const tags = new Set(["data_service"]);
  if (/sentiment|情绪|社媒|social/.test(value)) tags.add("sentiment_data");
  if (/fund flow|net[\s_-]?flow|netflow|资金流|净流入|净流出|inflow|outflow|链上|onchain/.test(value)) {
    tags.add("onchain_data");
    tags.add("fund_flow");
  }
  if (/net[\s_-]?flow|netflow|净流入|净流出/.test(value)) tags.add("netflow");
  if (/smart[\s_-]?money|smart money|聪明钱/.test(value)) {
    tags.add("smart_money");
    if (/net[\s_-]?flow|netflow|净流入|净流出|inflow|outflow/.test(value)) tags.add("smart_money_netflow");
    if (/holding|holdings|持仓|balance/.test(value)) tags.add("smart_money_holdings");
  }
  if (/funding|资金费率/.test(value)) {
    tags.add("crypto_derivatives");
    tags.add("funding_rate");
    tags.add("market_data");
  }
  if (/liquidation|max[\s_-]?pain|爆仓|清算|永续|合约/.test(value)) {
    tags.add("crypto_derivatives");
    tags.add("perp_liquidation");
    tags.add("liquidation_heatmap");
    tags.add("perp_liquidation_max_pain");
  }
  if (/price|价格|ticker|行情/.test(value)) tags.add("market_data");
  if (/\betf\b|exchange traded fund|bitcoin etf|btc etf/.test(value)) {
    tags.add("market_data");
    tags.add("etf_data");
  }
  if (/wallet|address|地址/.test(value)) tags.add("wallet_profile");
  if (/transfer|transfers|转账|流转/.test(value)) {
    tags.add("transfer_data");
    tags.add("token_transfers");
    tags.add("wallet_activity");
  }
  if (/transaction|transactions|txs?|交易/.test(value)) tags.add("transaction_data");
  if (/token|代币|tgm|token god mode/.test(value)) {
    tags.add("token_data");
    tags.add("token_analytics");
  }
  if (/token god mode|tgm/.test(value)) tags.add("token_god_mode");
  if (/leaderboard|ranking|rank|积分榜|排行榜/.test(value)) tags.add("leaderboard_data");
  if (/points|score|积分/.test(value)) tags.add("points_data");
  if (/portfolio|资产组合|持仓组合/.test(value)) tags.add("portfolio_data");
  if (/profiler|profile|画像/.test(value)) tags.add("address_intelligence");
  if (/prediction market|预测市场/.test(value)) tags.add("prediction_market_data");
  if (/newsflash|news flash|news|快讯|资讯/.test(value)) tags.add("news_data");
  if (/article|articles|report|research|文章|研报/.test(value)) tags.add("article_data");
  if (/original|first[-\s]?report|first report|首发/.test(value)) tags.add("original_source_data");
  if (/macro|m2|treasury|dxy|dollar index|yield|国债|美元指数/.test(value)) tags.add("macro_data");
  if (/hyperliquid|hl\b/.test(value)) {
    tags.add("hyperliquid_data");
    tags.add("crypto_derivatives");
  }
  return [...tags].join(",");
}
