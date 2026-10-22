import axios from "axios";
import puppeteer, { type Browser, type CDPSession } from "puppeteer-core";
import type { Provider, ProviderFetchResult } from "../types.js";
import { httpErrorMessage, lazy, requireEnv } from "./_shared.js";

const CLEARCOTE_BASE_URL = "https://www.clearcotelabs.com/api/v1";
/** Time kept back at the end of the budget to read the page before the runner's abort fires. */
const READ_RESERVE_MS = 3_000;
/** A 2xx page is final once the network has been quiet this long (a challenge answered in place reloads first). */
const QUIET_MS = 500;
const SETTLE_CAP_MS = 5_000;
/** Some pages never fire load (endless trackers): once the document is in, load gets a bounded wait. */
const LOAD_CAP_MS = 20_000;
/** A block page this quiet, with no challenge in progress, is retried on a fresh session (a new exit IP). */
const STUCK_QUIET_MS = 10_000;
const STUCK_RETRIES = 2;
/** A fresh session needs this much budget left to be worth starting (create + browser start + load). */
const RETRY_MIN_BUDGET_MS = 30_000;
/** ccTLDs sold as generic names: they say nothing about where a site's users are. */
const GENERIC_CCTLDS = new Set(["ai", "cc", "co", "fm", "gg", "io", "ly", "me", "so", "to", "tv", "ws"]);

const client = lazy(() =>
  axios.create({
    baseURL: CLEARCOTE_BASE_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("CLEARCOTE_API_KEY")}`
    }
  })
);

interface CreatedSession {
  id: string;
  connectUrl: string;
}

class StuckBlock extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isOk = (status: number): boolean => status >= 200 && status < 300;

/** The site's own country from its ccTLD (.ro -> RO, .co.uk -> GB); the US otherwise, where most targets are. */
function exitCountry(url: string): string {
  const tld = new URL(url).hostname.split(".").pop() ?? "";
  if (tld.length === 2 && !GENERIC_CCTLDS.has(tld)) return tld === "uk" ? "GB" : tld.toUpperCase();
  return "US";
}

/** A failed WebSocket connect rejects with an ErrorEvent, not an Error: keep its message readable. */
function asError(e: unknown): unknown {
  if (e instanceof Error || axios.isAxiosError(e) || typeof e !== "object" || e === null) return e;
  const o = e as { message?: unknown; error?: { message?: unknown } };
  return new Error(`connect: ${String(o.message ?? o.error?.message ?? JSON.stringify(e))}`);
}

/** POST /browsers, waiting out 503 NO_CAPACITY (Retry-After) while the budget allows — the wait counts as latency. */
async function createSession(url: string, timeoutMs: number, deadline: number, signal: AbortSignal): Promise<CreatedSession> {
  const sessionSec = Math.ceil(timeoutMs / 1000) + 30;
  for (;;) {
    try {
      const response = await client().post<CreatedSession>(
        "/browsers",
        {
          country: exitCountry(url),
          // Auto-select: token, clearance, block-page and image challenges. Score is left out.
          challengeService: true,
          timeoutSec: sessionSec,
          // We sit quietly while a challenge is answered: never let that count as idle.
          idleTimeoutSec: sessionSec,
          note: "wdf-benchmark"
        },
        { signal, timeout: Math.max(1_000, deadline - Date.now()) }
      );
      return response.data;
    } catch (e) {
      const retryAfterSec = axios.isAxiosError(e) && e.response?.status === 503 ? Number(e.response.data?.retryAfterSec ?? 5) : NaN;
      if (Number.isFinite(retryAfterSec) && Date.now() + retryAfterSec * 1000 < deadline - READ_RESERVE_MS) {
        await sleep(retryAfterSec * 1000);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Is the browser or the challenge service still working on a challenge in this session? Yes when its timeline
 * has a solvable detection and challenge activity in the last 30 s. Read at most every 5 s.
 */
function challengeTracker(sessionId: string): () => Promise<boolean> {
  let checkedAt = 0;
  let inProgress = true;
  return async () => {
    if (Date.now() - checkedAt < 5_000) return inProgress;
    checkedAt = Date.now();
    const events = await client()
      .get<{ events: Array<{ type: string; at: string; data?: { solvable?: boolean } }> }>(`/browsers/${sessionId}/events?limit=500`, { timeout: 5_000 })
      .then((r) => r.data.events)
      .catch(() => undefined);
    if (!events) return inProgress;
    const solvable = events.some((e) => e.type === "challenge.detected" && e.data?.solvable !== false);
    const lastActivity = Math.max(0, ...events.filter((e) => /^(challenge\.|slider$|checkbox$|pressHold$)/.test(e.type)).map((e) => Date.parse(e.at)));
    inProgress = solvable && Date.now() - lastActivity < 30_000;
    return inProgress;
  };
}

/**
 * Navigates over a raw CDP session on the page target. Its top frame id stays the same when Chrome swaps the
 * main frame into another process, which Puppeteer's Frame objects do not survive.
 */
async function navigate(cdp: CDPSession, url: string, remaining: () => number, challengeInProgress?: () => Promise<boolean>): Promise<ProviderFetchResult> {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const topFrameId = frameTree.frame.id;
  // The last top-frame document wins: a challenge page answered by the browser or the challenge service reloads
  // into the real page. responseReceived fires for the final hop only, so redirects never count as the answer.
  const main: { status?: number; requestId?: string; count: number } = { count: 0 };
  const inflight = new Set<string>();
  let lastActivity = Date.now();
  let loaded = false;
  const touch = (): void => void (lastActivity = Date.now());
  cdp.on("Network.requestWillBeSent", (e) => (inflight.add(e.requestId), touch()));
  cdp.on("Network.loadingFinished", (e) => (inflight.delete(e.requestId), touch()));
  cdp.on("Network.loadingFailed", (e) => (inflight.delete(e.requestId), touch()));
  cdp.on("Network.responseReceived", (e) => {
    if (e.type === "Document" && e.frameId === topFrameId) Object.assign(main, { status: e.response.status, requestId: e.requestId, count: main.count + 1 });
  });
  cdp.on("Page.loadEventFired", () => void (loaded = true));
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  const nav = await cdp.send("Page.navigate", { url });
  if (nav.errorText && main.status === undefined) throw new Error(`${nav.errorText} at ${url}`);
  while (!loaded && main.status === undefined && remaining() > 1) await sleep(100);
  const loadUntil = Date.now() + Math.min(remaining(), LOAD_CAP_MS);
  while (!loaded && Date.now() < loadUntil) await sleep(100);

  for (;;) {
    // A challenge page: wait for the browser or the challenge service to clear it.
    while (main.status !== undefined && !isOk(main.status) && remaining() > 1) {
      if (challengeInProgress && Date.now() - lastActivity >= STUCK_QUIET_MS && !(await challengeInProgress())) throw new StuckBlock(`blocked (${main.status})`);
      await sleep(250);
    }
    // A challenge served with a 2xx is answered in place and reloads: follow it until the network goes quiet.
    const seen = main.count;
    const settleUntil = Date.now() + Math.min(remaining(), SETTLE_CAP_MS);
    while (Date.now() < settleUntil && !(inflight.size === 0 && Date.now() - lastActivity >= QUIET_MS)) await sleep(100);
    if (main.count === seen || remaining() <= 1) break;
  }
  if (main.status === undefined || main.requestId === undefined) throw new Error(`no document response at ${url}`);

  // The final document as the server sent it, like the other providers return it; the rendered DOM only when
  // the body is gone (Chrome does not keep every response).
  const body = await cdp
    .send("Network.getResponseBody", { requestId: main.requestId })
    .then((r) => (r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body))
    .catch(async () => (await cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true })).result.value as string);
  return { statusCode: main.status, body };
}

/** One hosted session: create, connect once, navigate, read, and always end it. */
async function fetchOnce(url: string, timeoutMs: number, deadline: number, remaining: () => number, signal: AbortSignal, retryable: boolean): Promise<ProviderFetchResult> {
  let session: CreatedSession | undefined;
  let browser: Browser | undefined;
  const onAbort = (): void => void browser?.disconnect();
  signal.addEventListener("abort", onAbort);
  try {
    session = await createSession(url, timeoutMs, deadline, signal);
    // The connect URL is single-use and answers once the browser is up: connect once, never retry it.
    browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl, protocolTimeout: timeoutMs }).catch((e) => {
      throw asError(e);
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    return await navigate(await page.createCDPSession(), url, remaining, retryable ? challengeTracker(session.id) : undefined);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await browser?.disconnect().catch(() => undefined);
    if (session) await client().delete(`/browsers/${session.id}`, { timeout: 10_000 }).catch(() => undefined);
  }
}

/**
 * Clearcote hosted browsers — a real browser per request over CDP, with the challenge service on.
 * https://www.clearcotelabs.com/docs/cloud
 */
export const clearcote: Provider = {
  name: "clearcote",
  envKeys: ["CLEARCOTE_API_KEY"],
  async fetch(url, { timeoutMs, signal }) {
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(1, deadline - READ_RESERVE_MS - Date.now());
    for (let stuck = 0; ; ) {
      try {
        return await fetchOnce(url, timeoutMs, deadline, remaining, signal, stuck < STUCK_RETRIES);
      } catch (e) {
        const budget = remaining() >= RETRY_MIN_BUDGET_MS;
        // A worker that is full refuses the connect with 503, like POST /browsers does: start over on a new session.
        if (budget && e instanceof Error && e.message.includes("Unexpected server response: 503")) continue;
        if (budget && e instanceof StuckBlock && stuck++ < STUCK_RETRIES) continue;
        throw new Error(e instanceof StuckBlock ? `Clearcote ${e.message}` : httpErrorMessage("Clearcote", e));
      }
    }
  }
};
