/**
 * Brand colours for the share bars.
 *
 * The bars used a rotating palette assigned by position, so the colour said
 * where a row sat in the sort and nothing about what it was. That is actively
 * misleading when the rows are things a reader already has a colour for:
 * Ethereum drew orange and Bitcoin drew pale blue, which is each other's
 * identity, and a reader who knows the space has to override what they already
 * know to read the chart.
 *
 * Named rather than derived, because a brand colour is a fact about a project
 * and not something to compute. Anything not listed falls back to the rotating
 * palette, so an unknown chain still gets a distinguishable colour rather than
 * nothing.
 *
 * Values are the projects' own marks, adjusted only where one would vanish
 * against a light page.
 */
const BRAND: Record<string, string> = {
  // Chains
  ethereum: "#627eea",
  bitcoin: "#f7931a",
  // Solana's mark is a purple to green gradient and a flat colour has to pick
  // one. The green end reads as "up" beside a table of green and red change
  // cells, and next to BSC's yellow it looked like a status rather than an
  // identity. Purple is the half people recognise.
  solana: "#9945ff",
  bsc: "#f0b90b",
  "bnb chain": "#f0b90b",
  base: "#0052ff",
  tron: "#eb0029",
  arbitrum: "#12aaff",
  "arbitrum one": "#12aaff",
  optimism: "#ff0420",
  op: "#ff0420",
  avalanche: "#e84142",
  polygon: "#8247e5",
  "hyperliquid l1": "#97fce4",
  hyperliquid: "#97fce4",
  sui: "#4da2ff",
  aptos: "#06f9d5",
  near: "#00ec97",
  sei: "#9c1c1c",
  monad: "#836ef9",
  berachain: "#814625",
  blast: "#fcfc03",
  linea: "#61dfff",
  scroll: "#ffdeb5",
  mantle: "#65b3ae",
  starknet: "#ec796b",
  cardano: "#0033ad",
  ton: "#0098ea",
  "robinhood chain": "#00c805",
  // Stablecoin issuers
  usdt: "#009393",
  tether: "#009393",
  usdc: "#2775ca",
  dai: "#f5ac37",
  // Sky's USDS. Not a teal: USDT is already #009393 and the two were
  // indistinguishable in a share bar where they sit side by side.
  usds: "#f5a623",
  usde: "#2152f3",
  frax: "#000000",
  pyusd: "#0070ba",
  usd1: "#e8b923",
  fdusd: "#c8a13a",
  tusd: "#1c5cff",
  busd: "#f0b90b",
  susds: "#f5a623",
};

/**
 * The colour for a named row, or null when the name is not one we know.
 *
 * Matched case insensitively and on the leading word too, because the same
 * chain arrives as "Arbitrum" from one upstream and "Arbitrum One" from
 * another, and a share bar that colours them differently implies they are two
 * chains.
 */
export function brandColor(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return BRAND[key] ?? BRAND[key.split(/\s+/)[0]] ?? null;
}
