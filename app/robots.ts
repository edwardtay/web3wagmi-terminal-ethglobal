import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // The /api routes are plumbing for our own panels, not content.
      { userAgent: "*", allow: "/", disallow: ["/api/"] },
    ],
    sitemap: "https://terminal.web3wagmi.com/sitemap.xml",
  };
}
