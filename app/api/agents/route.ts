import { jsonResponse } from "@/lib/http";
import { readAgentEconomy } from "@/lib/agents";

// The ERC-8004 agent registries, across five chains.
//
// Budget: five gateway queries a refresh. At a thirty minute window that is
// 7,200 a month against the free tier's 100,000, and the window is right
// because these are cumulative registry counters on a daily rollup. A tighter
// one would return the same numbers and cost five times as much.

export const revalidate = 1800;

export async function GET() {
  const data = await readAgentEconomy(revalidate);
  if (!data) {
    return jsonResponse(
      { ok: false, rows: [], note: "No subgraph gateway key is configured, so the agent registries are unavailable." },
      revalidate
    );
  }
  return jsonResponse(
    {
      ok: data.answered > 0,
      asOf: new Date().toISOString(),
      ...data,
      // ok is about the read, not about every chain answering. One deployment
      // with no available indexer is a row with a reason in it.
      note:
        data.answered === data.attempted
          ? null
          : `${data.attempted - data.answered} of ${data.attempted} chains did not answer. The reason is on the row.`,
    },
    revalidate
  );
}
