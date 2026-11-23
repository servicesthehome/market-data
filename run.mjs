// Fetches public spot market data and sends it, signed, to the address in the ENDPOINT secret.
// Node built-ins only (venues.mjs is generated, no install). Prints only "ok" or a short error code.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { collect, HOSTS, VENUES } from "./venues.mjs";

const SOURCE = "https://data-api.binance.vision/api/v3";
const QUOTES = new Set(["USDT", "USDC", "USD"]);
const TIMEOUT_MS = 20_000;

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`source-${response.status}`);
  return response.json();
}

const getJson = (path) => fetchJson(`${SOURCE}${path}`);

export function buildPairs(info, tickers) {
  const byPair = new Map(tickers.map((t) => [t.symbol, t]));
  const pairs = [];
  for (const s of info.symbols) {
    const t = byPair.get(s.symbol);
    if (!t || !QUOTES.has(s.quoteAsset) || s.isSpotTradingAllowed === false) continue;
    pairs.push([
      s.symbol,
      s.baseAsset,
      s.quoteAsset,
      s.status,
      t.lastPrice,
      t.quoteVolume,
      t.highPrice,
      t.lowPrice,
      t.openPrice,
    ]);
  }
  return pairs;
}

export function signedHeaders(signingKey, body) {
  const [kid, key] = signingKey.split(":");
  if (!kid || !key) throw new Error("config");
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", Buffer.from(key, "base64url"))
    .update(`${kid}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-key-id": kid,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
    "x-signature": signature,
  };
}

async function main() {
  const { ENDPOINT, SIGNING_KEY, MEMBER_ID, RUN_ID } = process.env;
  if (!ENDPOINT || !SIGNING_KEY || !MEMBER_ID) throw new Error("config");
  // Binance and the other venues (S072) in parallel; one venue failing never stops the others.
  const [binance, others] = await Promise.all([
    Promise.all([getJson("/ticker/24hr"), getJson("/exchangeInfo?permissions=SPOT")]).then(
      ([tickers, info]) => buildPairs(info, tickers),
      () => null,
    ),
    collect(VENUES, HOSTS, fetchJson),
  ]);
  if (binance === null && Object.keys(others.venues).length === 0) throw new Error("sources");
  const body = JSON.stringify({
    v: 2,
    account: MEMBER_ID,
    run_id: String(RUN_ID ?? ""),
    fetched_at: new Date().toISOString(),
    pairs: binance ?? [],
    venues: others.venues,
    failed: binance === null ? ["binance", ...others.failed] : others.failed,
  });
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: signedHeaders(SIGNING_KEY, body),
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`send-${response.status}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    () => console.log("ok"),
    (error) => {
      const code = error instanceof Error && /^[a-z]+(-\d+)?$/.test(error.message) ? error.message : "error";
      console.log(code);
      process.exitCode = 1;
    },
  );
}
