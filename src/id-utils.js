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
  if (/wallet|address|地址/.test(value)) tags.add("wallet_profile");
  return [...tags].join(",");
}
