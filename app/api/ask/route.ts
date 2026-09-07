import { jsonResponse } from "@/lib/http";
import { ask, askReady } from "@/lib/ask";

// One question, one answer, grounded in this terminal's own routes.
//
// POST rather than GET on purpose: a question is not a cacheable resource, and
// putting free text in a URL would put it in every access log along the way.

export const dynamic = "force-dynamic";

/** Long enough for a real question, short enough that nobody pastes an essay. */
const MAX_QUESTION = 400;

export async function POST(req: Request) {
  if (!askReady()) {
    return jsonResponse({ ok: false, answer: null, used: [], note: "Ask is not configured on this deployment." }, 0);
  }

  let question = "";
  let focus = "";
  try {
    const body = (await req.json()) as { question?: unknown; focus?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
    focus = typeof body.focus === "string" ? body.focus.trim().slice(0, 12).toUpperCase() : "";
  } catch {
    return jsonResponse({ ok: false, answer: null, used: [], note: "Send JSON with a question field." }, 0);
  }

  if (!question) {
    return jsonResponse({ ok: false, answer: null, used: [], note: "Ask something." }, 0);
  }
  if (question.length > MAX_QUESTION) {
    return jsonResponse({ ok: false, answer: null, used: [], note: `Keep it under ${MAX_QUESTION} characters.` }, 0);
  }

  // The tools read our own routes, and they read them from inside the
  // container rather than through the public hostname.
  //
  // Going out through the public origin means going through the CDN, which
  // holds these routes for their s-maxage. That served the question layer a
  // copy of /api/netflow from before the holder fields existed, so the model
  // answered that it had no data on WBTC ownership while the live payload said
  // the ten largest addresses hold 53.1% of supply. Loopback has no edge in
  // front of it, and the routes do their own in-process caching anyway, so
  // nothing is lost by skipping it.
  const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

  try {
    const result = await ask(question, origin, focus || undefined);
    return jsonResponse(result, 0);
  } catch {
    return jsonResponse({ ok: false, answer: null, used: [], note: "The question could not be answered." }, 0);
  }
}
