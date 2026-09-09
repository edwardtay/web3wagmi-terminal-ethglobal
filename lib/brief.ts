import "server-only";
import { askReady, chat, plain, readRoute, tighten, type Session } from "./ask";
// Compact, not exact. The note is prose: "$48,232,273.99 left USDT reserves"
// is a number nobody reads aloud, and it spends the completion budget on
// digits that carry no more meaning than "$48.2m".
import { usdCompact } from "./format";

// The brief the terminal writes by itself.
//
// Everything else here answers a question. This one is not asked: it runs on a
// schedule, reads every desk, and writes down what a person coming to the
// market this morning would want told to them. That difference is the point.
// A terminal that answers when poked is a reference; one that has already
// looked is a colleague who got in early.
//
// One model call a day. The desks it reads are the same routes the assistant's
// tools read, so a brief cannot contain a number the terminal cannot show, and
// the evidence is assembled in code rather than gathered by the model: it is
// handed the readings and asked only to write them up.
//
// Deliberately not a forecast. It says what changed and what is unusual, and
// where a reading has a conventional meaning it says that, which is the same
// contract every other panel here keeps.

/** How long a brief stands before another is written. */
export const BRIEF_TTL = 6 * 60 * 60;

export interface Brief {
  /** The day this brief describes, in UTC. */
  date: string;
  writtenAt: string;
  text: string;
  /** Which desks were readable when it was written. */
  read: string[];
  /** Desks that could not be reached, named rather than silently dropped. */
  missing: string[];
}

interface Signals {
  signals?: { kind: string; symbol: string | null; headline: string; evidence: string; severity: number }[];
}
interface Netflow {
  tokens?: { sym: string; reservesUsd: number | null; flowUsd?: { h24: number | null } | null; holders?: { holders: number; topShare: number | null } | null }[];
  coverage?: { wallets: number; walletsTracked: number };
}
interface Derivs {
  funding?: { sym: string; annual: number; hlAnnual: number | null }[];
  oi?: { sym: string; regime: string; oiChangePct: number | null }[];
  hlPlatform?: { volumeUsd: number; buyUsd: number; liquidationsUsd: number } | null;
}
interface Breadth {
  above50?: { n: number; total: number };
  ad24?: { up: number; down: number };
  outperf7?: { n: number; total: number };
}
interface Stress {
  score?: number;
  percentile?: number;
  band?: { label: string };
}

const round = (n: number | null | undefined, d = 1): number | null =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d));

/**
 * Everything the brief is allowed to mention, gathered in code.
 *
 * The model is handed this and nothing else. It cannot call a tool, so it
 * cannot go looking for a number that suits a sentence it has already decided
 * to write, which is the failure mode of a model asked to survey rather than to
 * answer.
 */
async function evidence(origin: string): Promise<{ facts: Record<string, unknown>; read: string[]; missing: string[] }> {
  const [sig, flow, der, bre, str] = await Promise.all([
    readRoute<Signals>(origin, "/api/signals"),
    readRoute<Netflow>(origin, "/api/netflow"),
    readRoute<Derivs>(origin, "/api/derivs"),
    readRoute<Breadth>(origin, "/api/breadth"),
    readRoute<Stress>(origin, "/api/stress"),
  ]);

  const read: string[] = [];
  const missing: string[] = [];
  const facts: Record<string, unknown> = {};

  if (sig?.signals) {
    read.push("what changed");
    facts.abnormalNow = sig.signals.slice(0, 5).map((s) => ({
      kind: s.kind,
      asset: s.symbol,
      finding: s.headline,
      evidence: s.evidence,
    }));
  } else missing.push("the dislocation queue");

  if (flow?.tokens) {
    read.push("exchange flow");
    facts.exchangeFlow = flow.tokens.map((r) => ({
      asset: r.sym,
      reserves: usdCompact(r.reservesUsd),
      flow24h: usdCompact(r.flowUsd?.h24 ?? null),
      // Stated rather than left to be inferred: the sign means opposite things
      // on a stablecoin and on a coin.
      reading:
        r.flowUsd?.h24 == null
          ? null
          : r.sym === "USDT" || r.sym === "USDC"
            ? r.flowUsd.h24 > 0
              ? "buying power arriving"
              : "buying power leaving"
            : r.flowUsd.h24 > 0
              ? "supply arriving that can be sold"
              : "supply leaving, less to sell",
      holders: r.holders?.holders ?? null,
      topTenShare: round(r.holders?.topShare == null ? null : r.holders.topShare * 100),
    }));
    facts.exchangeFlowScope = `${flow.coverage?.wallets ?? 0} of ${flow.coverage?.walletsTracked ?? 0} labelled Ethereum wallets`;
  } else missing.push("exchange flow");

  if (der?.funding) {
    read.push("funding and open interest");
    const crowded = [...der.funding].sort((a, b) => Math.abs(b.annual) - Math.abs(a.annual)).slice(0, 4);
    facts.mostCrowdedFunding = crowded.map((f) => ({
      asset: f.sym,
      binanceAnnualisedPercent: round(f.annual),
      hyperliquidAnnualisedPercent: round(f.hlAnnual),
    }));
    facts.openInterestRegimes = (der.oi ?? []).slice(0, 5).map((o) => ({
      asset: o.sym,
      regime: o.regime,
      contractChange24hPercent: round(o.oiChangePct),
    }));
    if (der.hlPlatform && der.hlPlatform.volumeUsd > 0) {
      facts.onchainPerpVenue = {
        buySharePercent: round((der.hlPlatform.buyUsd / der.hlPlatform.volumeUsd) * 100),
        volume: usdCompact(der.hlPlatform.volumeUsd),
        liquidations: usdCompact(der.hlPlatform.liquidationsUsd),
      };
    }
  } else missing.push("derivatives");

  if (bre?.above50) {
    read.push("breadth");
    facts.breadth = {
      aboveFiftyDay: `${bre.above50.n} of ${bre.above50.total}`,
      risingVsFalling: bre.ad24 ? `${bre.ad24.up} up, ${bre.ad24.down} down` : null,
      beatingBitcoin7d: bre.outperf7 ? `${bre.outperf7.n} of ${bre.outperf7.total}` : null,
    };
  } else missing.push("breadth");

  if (str?.score != null) {
    read.push("stress");
    facts.stress = {
      score: round(str.score, 0),
      band: str.band?.label ?? null,
      percentileOfOwnYear: round(str.percentile, 0),
    };
  } else missing.push("the stress composite");

  return { facts, read, missing };
}

const SYSTEM = `You write the morning note for a crypto market terminal. You are given every reading it has and nothing else.

- Four to six sentences. Plain flowing prose, no headings, no bullets, no line breaks.
- Open with the single thing that matters most this morning and say why it matters, not merely what it is.
- Then the supporting picture in two or three sentences, joining readings that agree or disagree with each other. Joining them is the reason this is written rather than listed.
- Close with the one thing worth watching today. Not a forecast: name the reading that would change the picture.
- Every number must come from the readings given. If something is not in them, you do not know it.
- Use the reading already attached to a flow rather than deriving direction from a sign. Coins arriving is supply to sell; stablecoins arriving is buying power.
- Do not walk the list naming a figure per asset. Name at most three assets, and only where one is the exception that makes the general picture mean something.
- Never recommend a trade or say what to buy or sell. Describe conditions.
- Money is already formatted. Write it exactly as given, such as $168.1m.
- Plain ASCII punctuation. No dashes as punctuation. Never write "it is not X, it is Y".`;

export async function writeBrief(origin: string): Promise<Brief | null> {
  if (!askReady()) return null;

  const { facts, read, missing } = await evidence(origin);
  if (read.length === 0) return null;

  const now = new Date();
  const session: Session = { fallbackModel: null };
  const reply = await chat(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `Write the morning note for ${now.toISOString().slice(0, 10)}.`,
          "",
          JSON.stringify(facts, null, 1),
          "",
          missing.length ? `These desks could not be read: ${missing.join(", ")}. Do not mention them.` : "",
          "Four to six sentences. Open with what matters most and close with what to watch. Describe conditions and never recommend a trade.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    false,
    session,
    // Room for the reasoning this model does before it writes. At the default
    // the note came back one sentence long with the rest cut off.
    2000
  );

  const text = reply?.content ? tighten(plain(reply.content)) : null;
  if (!text) return null;

  return {
    date: now.toISOString().slice(0, 10),
    writtenAt: now.toISOString(),
    text,
    read,
    missing,
  };
}
