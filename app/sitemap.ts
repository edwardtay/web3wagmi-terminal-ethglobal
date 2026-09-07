import type { MetadataRoute } from "next";
import { ASSETS } from "@/lib/symbols";

const BASE = "https://terminal.web3wagmi.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: BASE, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${BASE}/thegraph`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/methodology`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${BASE}/status`, lastModified: now, changeFrequency: "hourly", priority: 0.4 },
    ...ASSETS.map((a) => ({
      url: `${BASE}/s/${a.sym}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
  ];
}
