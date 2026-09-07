import type { Metadata } from "next";
import { StatusClient } from "./StatusClient";
import { PageChrome } from "@/components/PageChrome";

export const metadata: Metadata = {
  title: "Data status | Web3WAGMI Terminal",
  description:
    "Live health of every feed behind the terminal: which upstreams are answering, how fast, and how old the data is.",
  alternates: { canonical: "https://terminal.web3wagmi.com/status" },
};

export default function StatusPage() {
  return (
    <PageChrome
      title="Data status"
      crumb="status"
      wide
      intro={
        <>
          Every panel on the terminal reads one of these routes. A route that answers with no data
          is marked degraded: the panel it feeds will say so in place rather than showing a stale or
          invented number. Checks run from your browser, so this is what your session is actually
          getting.
        </>
      }
    >
      <div className="mt-6">
        <StatusClient />
      </div>
      <p className="mt-6 text-xs text-[var(--text3)]">
        <a href="/" className="hover:text-[var(--text)]">
          Back to the terminal
        </a>
      </p>
    </PageChrome>
  );
}
