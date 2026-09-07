import "server-only";
import { postJson } from "./http";

// Exchange netflow, measured the honest way: read each labelled exchange
// wallet's token balance now and at a past block, and take the difference.
// A log scan would give the gross inflow and outflow split, but the free
// endpoints that serve archive eth_call reliably time out on a wide
// multi-address eth_getLogs, and the net figure is the number people act on.
//
// Set NETFLOW_RPC_ETH to a QuickNode (or any archive) endpoint to use it
// instead of the public pool. That is worth doing: the public endpoints are
// rate limited and single-call only, so this route fires ~240 requests where a
// paid endpoint would batch them.

// Verified to serve an archive `eth_call` at a historical block, which most
// free endpoints do not: ankr and publicnode both answer 200 and then refuse
// the archive read, cloudflare-eth errors internally, and llamarpc and
// flashbots were returning 5xx. merkle is kept despite rate limiting hard,
// because the rotation is what makes a limited endpoint useful.
const PUBLIC_ARCHIVE = [
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://eth.drpc.org",
  "https://eth.merkle.io",
];

function endpoints(): string[] {
  const own = process.env.NETFLOW_RPC_ETH;
  return own ? [own] : PUBLIC_ARCHIVE;
}

export interface TrackedToken {
  sym: string;
  /** Contract address, or null for native ETH. */
  address: string | null;
  decimals: number;
  /** Binance pair used to price it. Stablecoins are marked at $1. */
  pricePair: string | null;
  /** Stablecoins arriving on an exchange is buying power. Crypto arriving is potential supply. */
  kind: "stable" | "crypto";
}

// WETH is deliberately absent: the tracked wallets hold about a million dollars
// of it against a billion in native ETH, so it only added a noise row.
export const TOKENS: TrackedToken[] = [
  { sym: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, pricePair: null, kind: "stable" },
  { sym: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, pricePair: null, kind: "stable" },
  { sym: "ETH", address: null, decimals: 18, pricePair: "ETHUSDT", kind: "crypto" },
  { sym: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, pricePair: "BTCUSDT", kind: "crypto" },
];

export interface Wallet {
  venue: string;
  label: string;
  address: string;
  /**
   * Cold storage. Kept in the set on purpose: a hot-to-cold shuffle is an
   * internal move, and it only nets to zero if both ends are tracked.
   */
  cold?: boolean;
}

// Publicly labelled Ethereum exchange wallets, each verifiable on Etherscan.
// Every address here was checked to actually hold a meaningful balance in the
// tracked tokens. Addresses that are labelled but drained were dropped, since a
// venue reading zero looks like a broken feed rather than an empty wallet.
//
// Kraken and OKX are not represented: their commonly cited Ethereum labels hold
// four figures or less today, so their real reserves sit in wallets that cannot
// be verified from public labels. Including them would have implied coverage
// that does not exist.
export const WALLETS: Wallet[] = [
  { venue: "Binance", label: "Binance 8 (cold)", address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", cold: true },
  { venue: "Binance", label: "Binance 7 (cold)", address: "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8", cold: true },
  { venue: "Binance", label: "Binance 28", address: "0x5a52E96BAcdaBb82fd05763E25335261B270Efcb" },
  { venue: "Binance", label: "Binance 14", address: "0x28C6c06298d514Db089934071355E5743bf21d60" },
  { venue: "Binance", label: "Binance 15", address: "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549" },
  { venue: "Binance", label: "Binance 16", address: "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d" },
  { venue: "Binance", label: "Binance 17", address: "0x56Eddb7aa87536c09CCc2793473599fD21A8b17F" },
  { venue: "Binance", label: "Binance 6", address: "0x9696f59E4d72E237BE84fFD425DCaD154Bf96976" },
  { venue: "Bitfinex", label: "Bitfinex 1", address: "0x77134cbC06cB00b66F4c7e623D5fdBF6777635EC" },
  { venue: "Bybit", label: "Bybit 1", address: "0xf89d7b9c864f589bbF53a82105107622B35EaA40" },
  { venue: "Crypto.com", label: "Crypto.com 2", address: "0x46340b20830761efd32832A74d7169B29FEB9758" },
  { venue: "Coinbase", label: "Coinbase 10", address: "0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43" },
  { venue: "Gate.io", label: "Gate.io 1", address: "0x0D0707963952f2fBA59dD06f2b425ace40b492Fe" },
  { venue: "Gate.io", label: "Gate.io 3", address: "0x1C4b70a3968436B9A0a9cf5205c787eb81Bb558c" },
];

/** Blocks back per window. Ethereum averages 12 second blocks. */
export const WINDOWS = { h1: 300, h24: 7200, d7: 50_400 } as const;
export type WindowKey = keyof typeof WINDOWS;

interface RpcReply {
  result?: string;
  error?: { message?: string };
}

let rr = 0;

/** One JSON-RPC call, rotating across endpoints so no single host carries it all. */
async function call(method: string, params: unknown[]): Promise<string | null> {
  const pool = endpoints();
  // One attempt per endpoint rather than two overall. With three hosts and two
  // tries the rotation could land on the same rate-limited endpoint twice and
  // give up while two working ones went untried, which is how the whole desk
  // went dark on a day one host was returning 429.
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const url = pool[rr++ % pool.length];
    const res = await postJson<RpcReply>(url, { jsonrpc: "2.0", id: 1, method, params }, {
      revalidate: 0,
      timeout: 12_000,
    });
    if (res?.result) return res.result;
  }
  return null;
}

/** Run jobs with a concurrency cap, so 240 calls do not land at once. */
async function pooled<T>(jobs: (() => Promise<T>)[], limit = 12): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(runners);
  return out;
}

export async function blockNumber(): Promise<number | null> {
  const hex = await call("eth_blockNumber", []);
  if (!hex) return null;
  try {
    return Number(BigInt(hex));
  } catch {
    return null;
  }
}

function balanceOfData(address: string): string {
  return `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Balance of one token for one wallet at one block, in whole token units.
 * Hex is parsed with BigInt: a wei balance overflows a double.
 */
async function balance(token: TrackedToken, wallet: string, block: string): Promise<number | null> {
  const hex = token.address
    ? await call("eth_call", [{ to: token.address, data: balanceOfData(wallet) }, block])
    : await call("eth_getBalance", [wallet, block]);
  if (!hex || hex === "0x") return null;
  try {
    // Divide after converting to a Number scaled by decimals. Balances here are
    // far below 2^53 once scaled, so the precision loss is below display depth.
    return Number(BigInt(hex)) / 10 ** token.decimals;
  } catch {
    return null;
  }
}

export interface Reading {
  sym: string;
  venue: string;
  label: string;
  now: number | null;
  h1: number | null;
  h24: number | null;
  d7: number | null;
}

/**
 * Read every tracked token for every tracked wallet at the current block and
 * at each window's start block.
 */
export async function readBalances(tip: number): Promise<Reading[]> {
  const blocks: Record<string, string> = {
    now: "latest",
    h1: `0x${(tip - WINDOWS.h1).toString(16)}`,
    h24: `0x${(tip - WINDOWS.h24).toString(16)}`,
    d7: `0x${(tip - WINDOWS.d7).toString(16)}`,
  };

  interface Job {
    sym: string;
    wallet: Wallet;
    key: string;
    run: () => Promise<number | null>;
  }
  const jobs: Job[] = [];
  for (const t of TOKENS) {
    for (const w of WALLETS) {
      for (const [key, blk] of Object.entries(blocks)) {
        jobs.push({ sym: t.sym, wallet: w, key, run: () => balance(t, w.address, blk) });
      }
    }
  }

  const values = await pooled(jobs.map((j) => j.run));

  const byKey = new Map<string, Reading>();
  jobs.forEach((j, i) => {
    const id = `${j.sym}|${j.wallet.address}`;
    let row = byKey.get(id);
    if (!row) {
      row = { sym: j.sym, venue: j.wallet.venue, label: j.wallet.label, now: null, h1: null, h24: null, d7: null };
      byKey.set(id, row);
    }
    (row as unknown as Record<string, number | null>)[j.key] = values[i];
  });

  return [...byKey.values()];
}
