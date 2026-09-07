import Link from "next/link";
import { TerminalHeader } from "./TerminalHeader";
import { Tape } from "./Snapshot";

// The wrapper every page that is not the terminal itself sits in.
//
// A sub-page reached from the terminal used to lose every trace of it: the
// network brand strip stayed, the terminal's own header did not, and nothing
// on the page said which tool it belonged to or offered a way back. Landing on
// /status from a search result, the only clue was the URL.
//
// Two things carry the footprint, and both are worth having rather than one.
// The header keeps the tool's identity, its search and its controls present, so
// a reader can act without going back first. The breadcrumb states the position
// in words and gives the way back, which the header alone does not: a logo is a
// link people have to guess at.
//
// The breadcrumb also ships as structured data. It is what puts the trail under
// the result in a search listing rather than a bare URL, which is the same
// question answered for a reader who has not arrived yet.

export function PageChrome({
  title,
  crumb,
  intro,
  wide = false,
  children,
}: {
  /** The page heading, and the last crumb. */
  title: string;
  /** Path segment, for the structured data. */
  crumb: string;
  intro?: React.ReactNode;
  /** Prose pages read better narrow; a table page wants the room. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const base = "https://terminal.web3wagmi.com";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Web3WAGMI Terminal", item: base },
      { "@type": "ListItem", position: 2, name: title, item: `${base}/${crumb}` },
    ],
  };

  return (
    <div className="min-h-screen">
      <TerminalHeader />
      <Tape />

      <main className="shell py-6">
        <nav aria-label="Breadcrumb" className="mb-3 font-mono text-[11px] text-[var(--text3)]">
          <Link href="/" className="hover:text-[var(--text)]">
            Terminal
          </Link>
          <span className="mx-1.5" aria-hidden>
            /
          </span>
          <span className="text-[var(--text2)]">{title}</span>
        </nav>

        <div className={wide ? "" : "max-w-3xl"}>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--text)]">{title}</h1>
          {intro && <div className="mt-2 text-sm leading-relaxed text-[var(--text2)]">{intro}</div>}
        </div>

        <div className="mt-6">{children}</div>
      </main>

      <script
        type="application/ld+json"
        // Next escapes this for us; the object is ours and contains no user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  );
}
