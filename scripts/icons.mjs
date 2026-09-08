// Token marks, from the source that also names the asset.
//
// These were extracted from a logo package keyed by ticker, and two of them
// were simply wrong: ARB rendered as a plain black square and TAO on a red
// field, when Bittensor's mark is a white tau on black. A wrong logo is worse
// than none, because a lettered badge says "not known" and a wrong mark says
// something false with confidence.
//
// CoinGecko is keyed by asset id rather than ticker, which is the thing that
// went wrong: a ticker is not unique and several assets answer to TAO. Mapping
// each symbol to an explicit id below makes the choice deliberate and reviewable
// rather than a lookup that silently picks the wrong project.
//
// Run when the tracked universe in lib/symbols.ts changes:
//   node scripts/icons.mjs
//
// It writes public/icons/tokens/*.png and lib/tokenIcons.ts, whose version hash
// is content derived so a changed mark busts its own cache.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "icons", "tokens");

/**
 * Symbol to CoinGecko asset id.
 *
 * Explicit on purpose. Resolving by ticker is what produced a red TAO: the
 * search endpoint answers with whichever project matched first, and nothing in
 * the pipeline noticed it was the wrong one.
 */
const IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", XRP: "ripple",
  ADA: "cardano", DOGE: "dogecoin", AVAX: "avalanche-2", LINK: "chainlink",
  MATIC: "matic-network", UNI: "uniswap", AAVE: "aave", MKR: "maker", LDO: "lido-dao",
  OP: "optimism", ARB: "arbitrum", APT: "aptos", SUI: "sui", NEAR: "near",
  FIL: "filecoin", TAO: "bittensor", RENDER: "render-token", FET: "fetch-ai",
  PEPE: "pepe", SHIB: "shiba-inu", USDC: "usd-coin", USDT: "tether",
  WBTC: "wrapped-bitcoin",
};

/**
 * Marks whose canonical source is unusable here, with the reason.
 *
 * XRP's CoinGecko asset is an opaque near-white filled square: the symbol is
 * white and so is everything around it, so there is no ground to remove and
 * nothing to flatten. Every automatic treatment leaves a pale tile. The
 * override is not a preference about which logo is nicer, it is the only way
 * to get a mark that can be seen on a light page.
 *
 * Keep this list short and keep the reason next to the entry.
 */
const OVERRIDES = {
  // CoinMarketCap's static asset for XRP, which is the mark on its own ground.
  XRP: "https://s2.coinmarketcap.com/static/img/coins/128x128/52.png",
};

/** Rendered at 16 to 22px, so 48 covers a 2x screen with room to spare. */
const SIZE = 48;

const syms = Object.keys(IDS).sort();
const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${Object.values(IDS).join(",")}&per_page=250`;
const res = await fetch(url, { headers: { "User-Agent": "web3wagmi-terminal/1.0", Accept: "application/json" } });
if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`);
const byId = new Map((await res.json()).map((c) => [c.id, c]));

/**
 * Take the white ground off a mark, so something can be put behind it.
 *
 * Two shapes turn up and only one was handled first time. A logo can arrive as
 * an opaque white tile, and it can arrive as a mark sitting on a half
 * transparent white haze: XRP's corners are white at alpha 142, which the test
 * for an opaque ground walked straight past, so compositing it onto a dark
 * square just covered the square.
 *
 * Only fires when all four corners are near-white, because a logo that
 * legitimately fills its square must keep every pixel, and the opaque case
 * never touches a pixel the mark itself might own.
 */
async function dropWhiteGround(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => (y * info.width + x) * info.channels;
  const nearWhite = (i) => data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244;
  const corners = [at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1)];
  if (!corners.some((i) => data[i + 3] > 8) || !corners.every(nearWhite)) return png;

  // An opaque tile is safe to strip wholesale. A translucent haze is not: the
  // mark on top of it may itself be near-white, so only the pixels that are
  // still see-through count as ground.
  const opaqueGround = corners.every((i) => data[i + 3] > 250);
  for (let i = 0; i < data.length; i += info.channels) {
    if (!nearWhite(i)) continue;
    if (opaqueGround ? data[i + 3] > 250 : data[i + 3] < 250) data[i + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

/**
 * Would this mark disappear on a light background?
 *
 * Only the pixels that are actually drawn count. Averaging the transparent
 * ones in makes every logo look dark and the check never fires.
 */
async function tooPale(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 40) continue;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    lit += 1;
    sum += lum;
    if (lum < 140) dark += 1;
  }
  if (!lit) return false;
  return sum / lit > 200 && dark / lit < 0.08;
}

const pale = [];

/** One image, retried, with a gap between attempts and between downloads. */
async function withRetry(sym, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "web3wagmi-terminal/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      console.warn(`  ${sym}: HTTP ${r.status}, attempt ${attempt + 1}`);
    } catch (e) {
      console.warn(`  ${sym}: ${e.message}, attempt ${attempt + 1}`);
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  console.warn(`  ${sym}: gave up, it will render as a lettered badge`);
  return null;
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) rmSync(join(outDir, f));

const written = [];
for (const sym of syms) {
  const coin = byId.get(IDS[sym]);
  if (!coin?.image) {
    console.warn(`  ${sym}: no image, it will render as a lettered badge`);
    continue;
  }
  // Paced and retried. Fetching all of these back to back had the image CDN
  // hang up mid-download, which is the same shape of failure the market data
  // reads hit: a burst gets dropped, and a gap between requests fixes what a
  // faster loop cannot.
  const buf = await withRetry(sym, OVERRIDES[sym] ?? coin.image.split("?")[0]);
  if (!buf) continue;
  // Contain rather than cover, on a transparent ground: a mark that is not
  // square must not be cropped, and cropping is how a logo loses the part that
  // identifies it.
  let img = sharp(buf).resize(SIZE, SIZE, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  // A near-white mark on a transparent ground is invisible on a light page.
  //
  // Two of these ship that way and both are correct at the source: XRP's own
  // file is named xrp-symbol-white, and Bittensor's tau is white. Rendered on
  // this terminal they were a blank square, which is the same failure the
  // previous icon set had and the reason it used background variants.
  //
  // Measured rather than listed, because the next mark added could be the same
  // and a hardcoded list of two would not catch it. Anything too pale to read
  // gets its brand's own dark ground put behind it.
  // Some of these arrive as an opaque white tile rather than a transparent
  // mark, so the white has to come off before anything can be put behind it.
  // Compositing onto a dark ground without this does nothing at all: the tile
  // simply covers the ground, which is what happened first time round.
  let flat = await dropWhiteGround(await img.png().toBuffer());

  // Now that the ground is gone, is what remains too pale to read on a light
  // page? XRP's own file is a white symbol and Bittensor's tau is white, so
  // both came out as blank squares. Measured rather than listed, because the
  // next mark added could be the same.
  if (await tooPale(flat)) {
    // flatten rather than composite. Compositing a mark that is itself opaque
    // over a dark square leaves the square covered and the mark exactly as pale
    // as it was; flatten merges the alpha channel into the ground, which is the
    // operation actually wanted here.
    flat = await sharp(flat)
      .flatten({ background: { r: 17, g: 17, b: 20 } })
      .png()
      .toBuffer();
    pale.push(sym);
  }

  const png = await sharp(flat).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(outDir, `${sym.toLowerCase()}.png`), png);
  written.push([sym, png.length, coin.name]);
  await new Promise((r) => setTimeout(r, 250));
}

const hash = createHash("sha256");
for (const [sym] of written) hash.update(readFileSync(join(outDir, `${sym.toLowerCase()}.png`)));

writeFileSync(
  join(root, "lib", "tokenIcons.ts"),
  `// Generated by scripts/icons.mjs. Do not edit.
export const TOKEN_ICON_VERSION = "${hash.digest("hex").slice(0, 8)}";
// Tokens with an icon in public/icons/tokens. Anything absent renders as a
// lettered badge, which beats a wrong logo.

export const TOKEN_ICONS = new Set<string>([
${written.map(([s]) => `  "${s}",`).join("\n")}
]);
`
);

const total = written.reduce((a, [, n]) => a + n, 0);
console.log(`  ${written.length} marks, ${(total / 1024).toFixed(0)}KB total`);
if (pale.length) console.log(`  given a dark ground so they read on a light page: ${pale.join(", ")}`);
for (const [sym, n, name] of written) console.log(`    ${sym.padEnd(7)} ${String(n).padStart(5)}b  ${name}`);
