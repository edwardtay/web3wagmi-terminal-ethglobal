import type { Metadata, Viewport } from "next";
import Script from 'next/script'
import { Plus_Jakarta_Sans, Space_Grotesk, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { SiteNav } from "@/components/SiteNav";
import { AskBot } from "@/components/AskBot";

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display",
  display: "swap",
});
const mono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

const TITLE = "Web3WAGMI Terminal: crypto markets, live";
const DESC =
  "A professional crypto terminal. Live prices, perps funding and open interest, liquidations, options vol, on-chain TVL, stablecoin flows, gas, yields and cross-asset risk on one screen.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  metadataBase: new URL("https://terminal.web3wagmi.com"),
  applicationName: "Web3WAGMI Terminal",
  openGraph: {
    title: "Web3WAGMI Terminal",
    description: "Crypto markets, live: perps, options, on-chain, stablecoins, gas, yields and risk on one screen.",
    siteName: "Web3WAGMI Terminal",
    url: "https://terminal.web3wagmi.com",
    type: "website",
    // Required, not optional: a page-level openGraph REPLACES the root one, so
    // without images this shipped no og:image while still claiming
    // summary_large_image to Twitter. Shares rendered a bare card.
    images: [{ url: "https://web3wagmi.com/og.png?v=2", width: 1200, height: 630, alt: "Web3WAGMI Terminal" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Web3WAGMI Terminal",
    description: "Crypto markets, live: perps, options, on-chain, stablecoins, gas, yields and risk.",
    images: ["https://web3wagmi.com/og.png?v=2"],
  },
  alternates: { canonical: "https://terminal.web3wagmi.com" },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#f59e0b",
  width: "device-width",
  initialScale: 1,
};

// Light by default. Apply a stored dark choice before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('w3w-terminal-theme');document.documentElement.setAttribute('data-theme',t==='dark'?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <SiteNav active="tools" />
        {children}
              {/* Site-wide feedback drawer, the same file every property runs.
            Posts to data.web3wagmi.com/api/feedback, this brand's own app holding
            its own Resend key. next/script rather than a bare <script>: React
            creates a plain inline script without executing it on the client. */}
        {/* Reads the live desks through /api/ask. Separate from the feedback
            widget below it, which posts a message to a person. */}
        <AskBot />

        <Script
          src="/feedback-widget.js"
          strategy="lazyOnload"
          data-email="hi@web3wagmi.com"
          data-accent="#f59e0b"
          data-endpoint="https://data.web3wagmi.com/api/feedback"
        />
      </body>
    </html>
  );
}
