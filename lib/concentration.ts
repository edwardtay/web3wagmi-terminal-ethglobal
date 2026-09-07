import "server-only";
import { MAX_ITEMS, holders, tokenInfo, type Network } from "./graph";

// Who holds the supply, and how much of it sits in ten addresses.
//
// This is the read the flow desk cannot give. Flow says what moved in a day.
// Concentration says whether the asset is held by a market or by a committee,
// which is what decides whether a single holder's decision is a market event.
//
// Two things make the number honest rather than alarming.
//
// A large balance is not concentration. Ten addresses holding a big number
// means nothing without the circulating supply behind it, so every reading here
// is a share.
//
// Most of the top of any ERC-20 holder list is infrastructure. Bridges, pools,
// lending markets and the exchange wallets themselves are contracts, and they
// hold on behalf of many people. Counting them as concentrated holders would
// call every liquid token dangerously held. The Token API returns
// `is_contract`, so the two are separated rather than blended.
//
// Budget: two requests per token, both in the `token` category at $15 per
// million, which is the cheap one. Four tokens on the flow desk's four hour
// window is 1,440 requests a month and about two cents. The holders call
// retries twice on a failed read, so a bad minute costs at most two more.

export interface Concentration {
  /**
   * The token actually measured, which is not always the one asked for.
   * Native ETH has no contract and its onchain presence is WETH, so an ETH row
   * carries WETH's holders. Saying so beats a row that quietly means something
   * other than its label.
   */
  symbol: string;
  /** Addresses holding a non-zero balance. */
  holders: number;
  circulatingSupply: number;
  /** Share of circulating supply held by the largest addresses, 0 to 1. */
  topShare: number | null;
  /** How many addresses that share covers. Ten at most, per the plan's row cap. */
  topCount: number;
  /** The part of that share held by contracts: pools, bridges, lending markets. */
  contractShare: number | null;
  /** The part held by ordinary addresses, which is the part that can act alone. */
  walletShare: number | null;
  /** Largest single holder as a share of supply, and whether it is a contract. */
  largest: { share: number; isContract: boolean } | null;
}

export async function readConcentration(
  network: Network,
  contract: string,
  revalidate: number
): Promise<Concentration | null> {
  // Supply for a token the size of USDT scans billions of rows and takes well
  // past the default timeout, which returned null and read as "no data" rather
  // than "too slow".
  const [info, top] = await Promise.all([
    tokenInfo(network, contract, { revalidate, timeout: 45_000 }),
    holders(network, contract, { limit: MAX_ITEMS, revalidate, timeout: 45_000 }),
  ]);
  if (!info || !top || top.length === 0) return null;

  const supply = info.circulating_supply;
  // A share needs something to be a share of. Without supply the balances are
  // just numbers, and dividing by zero would produce an infinity that renders
  // as a very confident wrong answer.
  if (!Number.isFinite(supply) || supply <= 0) return null;

  const sum = (rows: typeof top) => rows.reduce((a, r) => a + (Number.isFinite(r.value) ? r.value : 0), 0);
  const contracts = top.filter((r) => r.is_contract);
  const wallets = top.filter((r) => !r.is_contract);
  const first = top[0];

  return {
    symbol: info.symbol ?? "",
    holders: info.holders,
    circulatingSupply: supply,
    topShare: sum(top) / supply,
    topCount: top.length,
    contractShare: sum(contracts) / supply,
    walletShare: sum(wallets) / supply,
    largest: first ? { share: first.value / supply, isContract: first.is_contract } : null,
  };
}

/** Requests one full read costs, so a caller can price itself. */
export const CALLS_PER_TOKEN = 2;
