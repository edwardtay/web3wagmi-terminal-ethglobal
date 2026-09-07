import { getJson, postJson, jsonResponse } from "@/lib/http";
import { allTickers24h } from "@/lib/binance";

// Transaction cost across chains. Everything here is read straight from a
// public JSON-RPC node or from mempool.space, so there is no API key and no
// aggregator sitting between the terminal and the chain.

export const revalidate = 60;

const GAS_TTL = 60;
const BTC_TTL = 300;

/** Gas units for the two transactions people actually price against. */
const TRANSFER_GAS = 21_000;
const SWAP_GAS = 150_000;

/** A plain BTC spend, one input two outputs, is close enough to 140 vB. */
const BTC_VBYTES = 140;

const HALVING_INTERVAL = 210_000;
const BTC_BLOCK_MS = 10 * 60 * 1000;

interface ChainDef {
  id: string;
  name: string;
  /** Native gas token, also the Binance base asset used to price it. */
  token: string;
  rpc: string;
  /** Rollups pay an extra L1 data fee that eth_feeHistory does not report. */
  l2: boolean;
}

const CHAINS: ChainDef[] = [
  { id: "ethereum", name: "Ethereum", token: "ETH", rpc: "https://ethereum-rpc.publicnode.com", l2: false },
  { id: "bnb", name: "BNB Chain", token: "BNB", rpc: "https://bsc-rpc.publicnode.com", l2: false },
  { id: "polygon", name: "Polygon PoS", token: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", l2: false },
  { id: "avalanche", name: "Avalanche C", token: "AVAX", rpc: "https://avalanche-c-chain-rpc.publicnode.com", l2: false },
  { id: "base", name: "Base", token: "ETH", rpc: "https://mainnet.base.org", l2: true },
  { id: "arbitrum", name: "Arbitrum One", token: "ETH", rpc: "https://arb1.arbitrum.io/rpc", l2: true },
  { id: "optimism", name: "OP Mainnet", token: "ETH", rpc: "https://mainnet.optimism.io", l2: true },
];

export interface ChainGas {
  id: string;
  name: string;
  token: string;
  l2: boolean;
  ok: boolean;
  /** Next-block base fee in gwei. Zero on chains without EIP-1559 pricing. */
  baseGwei: number;
  /** Median priority tip observed over the last 20 blocks, in gwei. */
  tipP10: number;
  tipP50: number;
  tipP90: number;
  /** What a wallet would actually pay per gas unit right now, in gwei. */
  effGwei: number;
  nativeUsd: number;
  transferUsd: number;
  swapUsd: number;
}

export interface BtcNetworkData {
  ok: boolean;
  btcUsd: number;
  vbytes: number;
  fees: { fastest: number; halfHour: number; hour: number; economy: number; minimum: number };
  mempool: { count: number; vsize: number; totalFeeSats: number; blocksDeep: number };
  hashrate: number;
  difficulty: number;
  /** Projected change at the next retarget, in percent. */
  difficultyChange: number | null;
  previousRetarget: number | null;
  retargetBlocks: number | null;
  retargetDate: string | null;
  tipHeight: number;
  halvingHeight: number;
  halvingBlocksLeft: number;
  halvingDate: string | null;
  /** Share of the current 210k reward epoch already mined, 0..100. */
  halvingProgress: number;
}

interface FeeHistory {
  baseFeePerGas?: string[];
  reward?: string[][];
}

/** Wei hex to gwei. Wei overflows a double on some chains, so parse as BigInt. */
function weiHexToGwei(hex: string | undefined): number {
  if (!hex) return 0;
  try {
    return Number(BigInt(hex)) / 1e9;
  } catch {
    return 0;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function readChain(c: ChainDef, priceOf: (token: string) => number): Promise<ChainGas> {
  const nativeUsd = priceOf(c.token);
  const dead: ChainGas = {
    id: c.id,
    name: c.name,
    token: c.token,
    l2: c.l2,
    ok: false,
    baseGwei: 0,
    tipP10: 0,
    tipP50: 0,
    tipP90: 0,
    effGwei: 0,
    nativeUsd,
    transferUsd: 0,
    swapUsd: 0,
  };

  const [histRes, priceRes] = await Promise.all([
    postJson<{ result?: FeeHistory }>(
      c.rpc,
      { jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: ["0x14", "latest", [10, 50, 90]] },
      { revalidate: GAS_TTL, timeout: 8000 }
    ),
    postJson<{ result?: string }>(
      c.rpc,
      { jsonrpc: "2.0", id: 2, method: "eth_gasPrice" },
      { revalidate: GAS_TTL, timeout: 8000 }
    ),
  ]);

  const hist = histRes?.result;
  const gasPriceGwei = weiHexToGwei(priceRes?.result);
  if (!hist && gasPriceGwei <= 0) return dead;

  const bases = hist?.baseFeePerGas ?? [];
  // The last entry is the estimate for the next block, which is what a wallet
  // would quote. Some nodes return one fewer entry, so just take the tail.
  const baseGwei = weiHexToGwei(bases[bases.length - 1]);

  const rewards = hist?.reward ?? [];
  const col = (i: number) => median(rewards.map((r) => weiHexToGwei(r?.[i])).filter(Number.isFinite));
  const tipP10 = col(0);
  const tipP50 = col(1);
  const tipP90 = col(2);

  // BNB Chain reports a zero base fee, so eth_gasPrice is the only honest
  // number there. Elsewhere the node's quote and base+tip agree closely.
  const effGwei = Math.max(baseGwei + tipP50, gasPriceGwei);
  // Without a native token price there is no USD cost, and a zero cost would
  // sort the chain to the top of a ranking that is entirely about cost. Keep
  // the gas readings, but do not claim the row is priced.
  if (effGwei <= 0 || nativeUsd <= 0) return { ...dead, baseGwei, tipP10, tipP50, tipP90, effGwei };

  const perGasUsd = (effGwei * 1e-9) * nativeUsd;
  return {
    id: c.id,
    name: c.name,
    token: c.token,
    l2: c.l2,
    ok: true,
    baseGwei,
    tipP10,
    tipP50,
    tipP90,
    effGwei,
    nativeUsd,
    transferUsd: perGasUsd * TRANSFER_GAS,
    swapUsd: perGasUsd * SWAP_GAS,
  };
}

interface RecommendedFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}
interface MempoolInfo {
  count: number;
  vsize: number;
  total_fee: number;
}
interface HashrateInfo {
  currentHashrate: number;
  currentDifficulty: number;
}
interface DiffAdjustment {
  difficultyChange: number;
  previousRetarget: number;
  remainingBlocks: number;
  estimatedRetargetDate: number;
}

async function readBtc(btcUsd: number): Promise<BtcNetworkData> {
  const base = "https://mempool.space/api";
  const [fees, mem, hash, tip, adj] = await Promise.all([
    getJson<RecommendedFees>(`${base}/v1/fees/recommended`, { revalidate: BTC_TTL }),
    getJson<MempoolInfo>(`${base}/mempool`, { revalidate: BTC_TTL }),
    getJson<HashrateInfo>(`${base}/v1/mining/hashrate/3d`, { revalidate: BTC_TTL }),
    getJson<number>(`${base}/blocks/tip/height`, { revalidate: BTC_TTL }),
    getJson<DiffAdjustment>(`${base}/v1/difficulty-adjustment`, { revalidate: BTC_TTL }),
  ]);

  const height = typeof tip === "number" && Number.isFinite(tip) ? tip : 0;
  const halvingHeight = height > 0 ? (Math.floor(height / HALVING_INTERVAL) + 1) * HALVING_INTERVAL : 0;
  const blocksLeft = halvingHeight > 0 ? halvingHeight - height : 0;

  return {
    ok: Boolean(fees && mem),
    btcUsd,
    vbytes: BTC_VBYTES,
    fees: {
      fastest: fees?.fastestFee ?? 0,
      halfHour: fees?.halfHourFee ?? 0,
      hour: fees?.hourFee ?? 0,
      economy: fees?.economyFee ?? 0,
      minimum: fees?.minimumFee ?? 0,
    },
    mempool: {
      count: mem?.count ?? 0,
      vsize: mem?.vsize ?? 0,
      totalFeeSats: mem?.total_fee ?? 0,
      // A block holds about 1M vbytes, so vsize in millions is depth in blocks.
      blocksDeep: (mem?.vsize ?? 0) / 1_000_000,
    },
    hashrate: hash?.currentHashrate ?? 0,
    difficulty: hash?.currentDifficulty ?? 0,
    difficultyChange: adj ? adj.difficultyChange : null,
    previousRetarget: adj ? adj.previousRetarget : null,
    retargetBlocks: adj ? adj.remainingBlocks : null,
    retargetDate: adj ? new Date(adj.estimatedRetargetDate).toISOString() : null,
    tipHeight: height,
    halvingHeight,
    halvingBlocksLeft: blocksLeft,
    halvingDate: blocksLeft > 0 ? new Date(Date.now() + blocksLeft * BTC_BLOCK_MS).toISOString() : null,
    halvingProgress: halvingHeight > 0 ? ((HALVING_INTERVAL - blocksLeft) / HALVING_INTERVAL) * 100 : 0,
  };
}

export async function GET() {
  const asOf = new Date().toISOString();
  try {
    const tickers = await allTickers24h(GAS_TTL);
    const priceMap = new Map<string, number>();
    for (const t of tickers ?? []) {
      if (t.symbol.endsWith("USDT")) {
        const v = Number(t.lastPrice);
        if (Number.isFinite(v) && v > 0) priceMap.set(t.symbol.slice(0, -4), v);
      }
    }
    const priceOf = (token: string) => priceMap.get(token) ?? 0;

    const [chains, btc] = await Promise.all([
      Promise.all(CHAINS.map((c) => readChain(c, priceOf))),
      readBtc(priceOf("BTC")),
    ]);

    // Cheapest first: the ranking is the point of the panel. Dead RPCs sink.
    const sorted = [...chains].sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.transferUsd - b.transferUsd;
    });

    return jsonResponse(
      { ok: sorted.some((c) => c.ok) || btc.ok, asOf, transferGas: TRANSFER_GAS, swapGas: SWAP_GAS, chains: sorted, btc },
      GAS_TTL
    );
  } catch {
    return jsonResponse(
      { ok: false, asOf, transferGas: TRANSFER_GAS, swapGas: SWAP_GAS, chains: [], btc: null },
      GAS_TTL
    );
  }
}
