import { jsonResponse } from "@/lib/http";
import { BRIEF_TTL, writeBrief, type Brief } from "@/lib/brief";

// The morning note, written once and then stood by.
//
// One model call per window, not one per reader. The whole point of a standing
// note is that everybody sees the same one, and regenerating it per visitor
// would both cost a call each time and give two people different accounts of
// the same morning.
//
// Held in this process, so a restart loses the archive. That is a real limit
// and it is stated on the panel rather than papered over: the alternative is a
// database this terminal does not otherwise need.

export const dynamic = "force-dynamic";
export const revalidate = 0;

let current: { at: number; brief: Brief } | null = null;
/** Earlier notes, newest first, for as long as this process lives. */
const archive: Brief[] = [];
let inflight: Promise<Brief | null> | null = null;

function fresh(): Brief | null {
  if (!current) return null;
  return Date.now() - current.at < BRIEF_TTL * 1000 ? current.brief : null;
}

export async function GET() {
  const hit = fresh();
  if (hit) {
    return jsonResponse({ ok: true, brief: hit, archive: archive.slice(0, 4), note: null }, 300);
  }

  const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

  // Coalesced. Several readers arriving at once must not each pay for a note.
  if (!inflight) {
    inflight = writeBrief(origin)
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  const brief = await inflight;

  if (!brief) {
    // The previous note rather than nothing. A stale brief with its own date on
    // it is honest; an empty panel says the terminal has nothing to say.
    const last = current?.brief ?? null;
    return jsonResponse(
      {
        ok: Boolean(last),
        brief: last,
        archive: archive.slice(0, 4),
        note: last
          ? "This note could not be rewritten, so the last one stands."
          : "No note yet. The model is unavailable.",
      },
      120
    );
  }

  if (current && current.brief.writtenAt !== brief.writtenAt) {
    archive.unshift(current.brief);
    archive.length = Math.min(archive.length, 8);
  }
  current = { at: Date.now(), brief };
  return jsonResponse({ ok: true, brief, archive: archive.slice(0, 4), note: null }, 300);
}
