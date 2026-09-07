// Warm the expensive desks once, when the server boots.
//
// The flow desk builds 176 metered reads before it answers, and it holds the
// result for four hours. That means one unlucky request pays for all of it, and
// after a deploy that request is the first visitor, who gets an empty panel
// while the work happens. QA caught exactly that: /api/netflow answered ok:false
// on the first call after a deploy and ok:true a minute later.
//
// Warming on boot moves the cost off a reader and onto the container's own
// startup, where nobody is waiting.

export async function register() {
  // Runs in the edge runtime and during the build too, where there is no server
  // to call and nothing worth warming.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const port = process.env.PORT ?? 3000;
  const origin = `http://127.0.0.1:${port}`;

  // Deliberately not awaited by the caller: startup must not wait on an
  // upstream, and a warm that fails is a slow first request rather than a
  // broken boot.
  void (async () => {
    // The server is not listening the instant this hook runs.
    await new Promise((r) => setTimeout(r, 3000));
    // Unlocks is warmed before signals because signals reads it, and a cold
    // unlocks parse is the slowest thing in the app.
    for (const path of ["/api/netflow", "/api/unlocks", "/api/signals"]) {
      try {
        await fetch(`${origin}${path}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        // A cold desk is the worst case, which is where we already were.
      }
    }
  })();
}
