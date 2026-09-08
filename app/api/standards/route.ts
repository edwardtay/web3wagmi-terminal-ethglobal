import { jsonResponse } from "@/lib/http";
import { readStandards } from "@/lib/standards";

// One query, nine protocols, four categories.
//
// Budget: ten gateway queries a refresh. At a 30 minute window that is 14,400 a
// month against the free tier's 100,000, and the window is the only lever that
// matters: these are protocol level totals that move on a daily snapshot, so a
// tighter window would buy nothing and cost five times as much.

export const revalidate = 1800;

export async function GET() {
  const data = await readStandards(revalidate);
  if (!data) {
    return jsonResponse(
      {
        ok: false,
        query: null,
        rows: [],
        bespoke: null,
        note: "No subgraph gateway key is configured, so the standardized schema is unavailable.",
      },
      revalidate
    );
  }

  // ok is about the read, not about every protocol answering. One subgraph
  // being reindexed is a row with a reason in it, not a failed desk.
  const answered = data.rows.filter((r) => !r.error).length;
  return jsonResponse(
    {
      ok: answered > 0,
      asOf: new Date().toISOString(),
      answered,
      attempted: data.rows.length,
      ...data,
      note:
        answered === data.rows.length
          ? null
          : `${data.rows.length - answered} of ${data.rows.length} did not answer. The reason is on the row.`,
    },
    revalidate
  );
}
