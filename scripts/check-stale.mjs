#!/usr/bin/env node
// Find market figures welded into user-facing copy.
//
// Two of these had already gone stale by the time anybody looked: a tooltip
// said Aave v3 reads $24.7b when the row beside it read $24.4b, and a note said
// a pool held $206m when the subgraph said $203m. Neither was wrong when it was
// written. That is the whole problem: prose does not refresh, and a figure in
// prose sitting next to the same figure live is the one kind of error a reader
// is guaranteed to notice.
//
// This cannot tell a market figure from a threshold, so it does not try. It
// lists every literal amount inside copy a reader sees and expects each one to
// be either self-evidently fixed, like a plan price, or listed below. Run it
// before a submission and read the list.
//
//   node scripts/check-stale.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Figures that are constants of the system rather than readings off it. */
const ALLOWED = [
  /\$25 (of )?credit/i,          // the Token API plan
  /\$200 per million/i,          // published price, historical category
  /\$15 per million/i,           // published price, token category
  /\$1\.00|\$1\b/,               // a dollar peg is definitionally a dollar
  /100,000 queries/i,            // the gateway's free tier
  /\$100M of circulating/i,      // an inclusion threshold this code sets
  /1% of market cap/i,           // an inclusion threshold this code sets
  /protocols over \$50M/i,        // an inclusion threshold this code sets
  // Arithmetic on the published prices rather than a market reading: 168 reads
  // a refresh at $200 per million is $24.19 hourly and $96.77 every fifteen
  // minutes, both checked against the same constants the code uses.
  /\$24\.19|\$96\.77|\$6\.05/,
];

const FIGURE = /\$\s?\d[\d.,]*\s?(?:m|b|k|bn)?\b|\b\d{1,3}(?:,\d{3})+\b/gi;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of [...walk("components"), ...walk("app")]) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    // Copy a reader sees: a hint prop, or a JSX text node. Not a comment, not
    // a className, not a computed expression.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    const isCopy = /hint="|<p |<span |<summary|title="/.test(line) || /^\s*[A-Z][a-z]/.test(line);
    if (isComment || !isCopy) return;
    if (/className|color-mix|viewBox|max-w-|w-\[|h-\[/.test(line)) return;
    for (const m of line.match(FIGURE) ?? []) {
      if (ALLOWED.some((re) => re.test(line))) continue;
      hits.push({ file, line: i + 1, figure: m, text: line.trim().slice(0, 100) });
    }
  });
}

if (!hits.length) {
  console.log("check-stale: OK, no unexplained figures in user-facing copy.");
  process.exit(0);
}
console.log(`check-stale: ${hits.length} figure(s) written into copy. Each should be a constant, not a reading.\n`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.figure}]  ${h.text}`);
process.exit(1);
