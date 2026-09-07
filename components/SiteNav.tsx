// Cross-site chrome, canonical across every web3wagmi subdomain. Structure and
// class names must stay identical; only the theme tokens differ here because
// the terminal carries its own theme tokens. Keep in sync with every web3wagmi property.

// Tools is a hub page rather than a subdomain: the terminal, the portfolio, the
// yield agent and the data finder all live under it, so the bar stays five
// items as the tool count grows.
const LINKS = [
  { href: "https://news.web3wagmi.com", label: "News", key: "news" },
  { href: "https://blog.web3wagmi.com", label: "Blog", key: "blog" },
  { href: "https://atlas.web3wagmi.com", label: "Atlas", key: "atlas" },
  { href: "https://events.web3wagmi.com", label: "Events", key: "events" },
  { href: "https://web3wagmi.com/tools", label: "Tools", key: "tools" },
] as const;

export type NavPage = (typeof LINKS)[number]["key"];

// The web3wagmi cube. Inlined rather than an <img> so it stays crisp at any
// size and ships no extra request, same mark as public/favicon.svg.
export function BrandCube({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#f59e0b" />
      <g
        transform="translate(4 4)"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </g>
    </svg>
  );
}

export function SiteNav({ active = "tools" }: { active?: NavPage }) {
  return (
    <>
      <div className="site-brand">
        <div className="site-brand-inner">
          <a href="https://web3wagmi.com" className="site-brand-link" aria-label="web3wagmi home">
            <BrandCube className="site-brand-mark" />
            <span className="site-brand-text">
              web3<span>wagmi</span>
            </span>
          </a>
        </div>
      </div>

      <nav className="site-nav">
        <div className="site-nav-inner">
          {LINKS.map((link, i) => (
            <span className="site-nav-item" key={link.key}>
              {i > 0 && (
                <span className="site-nav-dot" aria-hidden="true">
                  ·
                </span>
              )}
              <a href={link.href} className={`site-nav-link${active === link.key ? " active" : ""}`}>
                {link.label}
              </a>
            </span>
          ))}
        </div>
      </nav>
    </>
  );
}
