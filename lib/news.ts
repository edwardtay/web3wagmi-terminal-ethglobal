import "server-only";
import { getJson } from "./http";
import { BY_SYM } from "./symbols";

// Headlines, from the web3wagmi news desk.
//
// This is the one thing the terminal genuinely could not do. Every other panel
// measures something, and a measurement cannot say why it moved. Asked why an
// asset jumped fourteen percent, the honest answer was that the cause is not
// visible here, which is true and unsatisfying.
//
// It is coverage, not causation, and the distinction is the whole point. A
// headline published near a move is not the reason for it, and this file never
// says it is: it returns what is being reported and leaves the join to the
// reader. Presenting a nearby headline as an explanation is how a terminal
// starts inventing narrative.
//
// The upstream is our own news service, which already applies a source
// reputation bar, so nothing here has to judge publishers.

const SRC = "https://news.web3wagmi.com/api/news";

interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  snippet?: string;
}

/** An entity the desk has counted across the feed, with its own headlines. */
interface Mention {
  name: string;
  type: string;
  count: number;
  headlines?: string[];
}

interface NewsPayload {
  items?: NewsItem[];
  mentions?: Mention[];
  total?: number;
  updated?: string;
}

export interface Coverage {
  /** Assets the feed is talking about most, ranked. */
  loudest: { name: string; mentions: number }[];
  /** Headlines for the asset asked about, when one was. */
  about?: { name: string; mentions: number; headlines: string[] };
  /** The most recent few, whatever the subject. */
  latest: { title: string; source: string; when: string }[];
  updated: string | null;
}

/**
 * Names an asset might appear under.
 *
 * The feed counts entities by name, so TAO is filed as Bittensor and ETH as
 * Ethereum. Matching on the ticker alone finds nothing for most of the
 * universe, which is the sort of gap that reads as "no news" when there is
 * plenty.
 */
function namesFor(sym: string): string[] {
  const asset = BY_SYM[sym];
  return [sym, asset?.name].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());
}

export async function readCoverage(symbol?: string, revalidate = 600): Promise<Coverage | null> {
  const data = await getJson<NewsPayload>(`${SRC}?limit=60`, { revalidate, timeout: 20_000 });
  if (!data) return null;

  const mentions = (data.mentions ?? []).filter((m) => m.type === "token");
  const loudest = mentions.slice(0, 6).map((m) => ({ name: m.name, mentions: m.count }));

  let about: Coverage["about"];
  if (symbol) {
    const wanted = namesFor(symbol);
    const hit = mentions.find((m) => wanted.includes(m.name.toLowerCase()));
    if (hit) {
      about = { name: hit.name, mentions: hit.count, headlines: (hit.headlines ?? []).slice(0, 5) };
    }
  }

  const latest = (data.items ?? []).slice(0, 5).map((i) => ({
    title: i.title,
    source: i.source,
    when: i.pubDate,
  }));

  return { loudest, about, latest, updated: data.updated ?? null };
}
