// Container health check. Deliberately dependency-free: it answers whether the
// process is serving, not whether every upstream is up (that is /status).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, ts: new Date().toISOString() });
}
