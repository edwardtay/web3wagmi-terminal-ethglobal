// The tracked universe. One list so the tape, the board, the screener, the
// correlation matrix and the command palette all agree on what "the market" is.

export interface Asset {
  /** Display symbol, e.g. "BTC". */
  sym: string;
  name: string;
  /** Binance spot pair. */
  pair: string;
  /** Binance USDT-margined perp (same string on fapi), when one exists. */
  perp?: string;
  /** Coarse sector, used by the rotation and breadth panels. */
  sector: Sector;
}

export type Sector =
  | "Majors"
  | "L1"
  | "L2"
  | "DeFi"
  | "AI"
  | "Meme"
  | "Infra"
  | "Exchange";

export const ASSETS: Asset[] = [
  { sym: "BTC", name: "Bitcoin", pair: "BTCUSDT", perp: "BTCUSDT", sector: "Majors" },
  { sym: "ETH", name: "Ethereum", pair: "ETHUSDT", perp: "ETHUSDT", sector: "Majors" },
  { sym: "SOL", name: "Solana", pair: "SOLUSDT", perp: "SOLUSDT", sector: "L1" },
  { sym: "BNB", name: "BNB", pair: "BNBUSDT", perp: "BNBUSDT", sector: "Exchange" },
  { sym: "XRP", name: "XRP", pair: "XRPUSDT", perp: "XRPUSDT", sector: "L1" },
  { sym: "ADA", name: "Cardano", pair: "ADAUSDT", perp: "ADAUSDT", sector: "L1" },
  { sym: "AVAX", name: "Avalanche", pair: "AVAXUSDT", perp: "AVAXUSDT", sector: "L1" },
  { sym: "SUI", name: "Sui", pair: "SUIUSDT", perp: "SUIUSDT", sector: "L1" },
  { sym: "APT", name: "Aptos", pair: "APTUSDT", perp: "APTUSDT", sector: "L1" },
  { sym: "TON", name: "Toncoin", pair: "TONUSDT", perp: "TONUSDT", sector: "L1" },
  { sym: "NEAR", name: "NEAR", pair: "NEARUSDT", perp: "NEARUSDT", sector: "L1" },
  { sym: "ARB", name: "Arbitrum", pair: "ARBUSDT", perp: "ARBUSDT", sector: "L2" },
  { sym: "OP", name: "Optimism", pair: "OPUSDT", perp: "OPUSDT", sector: "L2" },
  { sym: "MATIC", name: "Polygon", pair: "POLUSDT", perp: "POLUSDT", sector: "L2" },
  { sym: "UNI", name: "Uniswap", pair: "UNIUSDT", perp: "UNIUSDT", sector: "DeFi" },
  { sym: "AAVE", name: "Aave", pair: "AAVEUSDT", perp: "AAVEUSDT", sector: "DeFi" },
  { sym: "LDO", name: "Lido DAO", pair: "LDOUSDT", perp: "LDOUSDT", sector: "DeFi" },
  { sym: "MKR", name: "Maker", pair: "MKRUSDT", perp: "MKRUSDT", sector: "DeFi" },
  { sym: "LINK", name: "Chainlink", pair: "LINKUSDT", perp: "LINKUSDT", sector: "Infra" },
  { sym: "FIL", name: "Filecoin", pair: "FILUSDT", perp: "FILUSDT", sector: "Infra" },
  { sym: "RENDER", name: "Render", pair: "RENDERUSDT", perp: "RENDERUSDT", sector: "AI" },
  { sym: "FET", name: "Artificial Superintelligence", pair: "FETUSDT", perp: "FETUSDT", sector: "AI" },
  { sym: "TAO", name: "Bittensor", pair: "TAOUSDT", perp: "TAOUSDT", sector: "AI" },
  { sym: "DOGE", name: "Dogecoin", pair: "DOGEUSDT", perp: "DOGEUSDT", sector: "Meme" },
  { sym: "SHIB", name: "Shiba Inu", pair: "SHIBUSDT", perp: "1000SHIBUSDT", sector: "Meme" },
  { sym: "PEPE", name: "Pepe", pair: "PEPEUSDT", perp: "1000PEPEUSDT", sector: "Meme" },
  { sym: "WIF", name: "dogwifhat", pair: "WIFUSDT", perp: "WIFUSDT", sector: "Meme" },
];

/** The short list the tape and the snapshot row lead with. */
export const HEADLINE = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];

/** Symbols used for the cross-asset matrices (kept small so the grid reads). */
export const MATRIX = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX", "LINK", "DOGE"];

export const BY_SYM: Record<string, Asset> = Object.fromEntries(ASSETS.map((a) => [a.sym, a]));

export function assetForPair(pair: string): Asset | undefined {
  return ASSETS.find((a) => a.pair === pair);
}

/** "BTCUSDT" -> "BTC/USDT" for display. */
export function prettyPair(pair: string): string {
  return pair.replace(/USDT$/, "/USDT").replace(/USDC$/, "/USDC");
}
