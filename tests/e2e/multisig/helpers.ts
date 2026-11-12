import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { DAPP_ORIGIN } from "../mocks/services";
import { invoke, type Outcome } from "../pages/connector";

/** The wallet's English catalog: the window runs in `en-US` (the browser locale of the fixtures). */
const catalog = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../src/i18n/locales/en-US.json"), "utf8")
) as { connector: { multisig: { declined: string } } };

export type Method = "commit" | "sign";
export const METHODS: Method[] = ["commit", "sign"];

/** The external request names. Tests cannot import the const enum. */
export const EXTERNAL: Record<Method, string> = {
  commit: "ext:multisig-commit",
  sign: "ext:multisig-sign"
};

/** The internal request names. */
export const INTERNAL: Record<Method, string> = {
  commit: "int:multisig-commit",
  sign: "int:multisig-sign"
};

/** The review window's route, and the one control that declines (`common.cancel`). */
export const REVIEW_URL = /\/connector\/index\.html#\/multisig$/;
export const DECLINE = "Cancel";

const REQUEST = '{"MSR":"x"}';
const item = (id: string, request: unknown = REQUEST) => ({ id, request });

/**
 * A run that fails exactly one item check, with that check's `info`. A row with `items` goes
 * through the page's own API. A row with `data` is a message the API cannot form, and goes
 * through the page channel.
 */
export type BadRun = { name: string; info: string } & ({ items: unknown } | { data: unknown });

export const BAD_RUNS: BadRun[] = [
  { name: "data that is no object", info: "Invalid items.", data: "x" },
  { name: "data with no items", info: "Invalid items.", data: {} },
  { name: "items that is a string", info: "Invalid items.", items: "x" },
  { name: "an empty list", info: "Invalid items.", items: [] },
  {
    name: "21 items",
    info: "Invalid items.",
    items: Array.from({ length: 21 }, (_, i) => item(String(i)))
  },
  { name: "an entry that is no object", info: "Invalid id.", items: ["x"] },
  { name: "an id that is a number", info: "Invalid id.", items: [{ id: 1, request: REQUEST }] },
  { name: "an empty id", info: "Invalid id.", items: [item("")] },
  { name: "an id of 65 characters", info: "Invalid id.", items: [item("a".repeat(65))] },
  { name: "two items with one id", info: "Duplicate id.", items: [item("a"), item("a")] },
  { name: "a request that is a number", info: "Invalid request.", items: [item("a", 1)] },
  {
    name: "a request of 1,000,001 characters",
    info: "Invalid request.",
    items: [item("a", "a".repeat(1_000_001))]
  },
  { name: "a request with U+0001", info: "Invalid request.", items: [item("a", "a\u0001b")] },
  { name: "a request with U+007F", info: "Invalid request.", items: [item("a", "a\u007fb")] },
  { name: "a request with U+00E9", info: "Invalid request.", items: [item("a", "a\u00e9b")] }
];

/**
 * Runs `call` and asserts that it opened no window. One more round trip to the background
 * follows the call, so a window the background opened late is seen too. A call that opens a
 * window may wait on it for good, so the first window ends the wait and fails the test.
 */
export async function expectNoWindow<R>(
  context: BrowserContext,
  page: Page,
  call: () => Promise<R>
): Promise<R> {
  const opened: Page[] = [];
  let windowOpened!: () => void;
  const firstWindow = new Promise<void>((resolve) => (windowOpened = resolve));
  const onPage = (p: Page) => {
    opened.push(p);
    windowOpened();
  };
  context.on("page", onPage);
  try {
    const answered = call();
    answered.catch(() => undefined);
    await Promise.race([answered, firstWindow]);
    await page.evaluate(() => window.ergoConnector.nautilus.isAuthorized());
    // with no window this passes at once; a window's last URL names the route it reached
    await expect.poll(() => opened.map((p) => p.url()), { message: "windows opened" }).toEqual([]);
    return await answered;
  } finally {
    context.off("page", onPage);
  }
}

type BridgePort = { first: Promise<MessagePort>; ports: MessagePort[] };

declare global {
  interface Window {
    /** Set by {@link keepBridgePort} in a page opened by {@link openChannelPage}. */
    bridgePort: BridgePort;
  }
}

/**
 * Init script of the page channel. It runs before `injected.js` and keeps the port that wins the
 * bridge's handshake, in either branch: the page's own offer (its `port1` hears "port-accepted"),
 * or the content script's offer (the page answers "port-accepted" on it). It adds listeners and
 * replaces none of the bridge's own.
 */
function keepBridgePort() {
  const ports: MessagePort[] = [];
  let resolve!: (port: MessagePort) => void;
  const first = new Promise<MessagePort>((r) => (resolve = r));
  const accepted = (port: MessagePort) => {
    if (!ports.includes(port)) ports.push(port);
    resolve(port);
  };

  const Native = window.MessageChannel;
  window.MessageChannel = class extends Native {
    constructor() {
      super();
      this.port1.addEventListener("message", (e) => {
        if (e.data === "port-accepted") accepted(this.port1);
      });
    }
  };

  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
    if (args[0] === "port-accepted") accepted(this);
    return Reflect.apply(post, this, args);
  };

  window.bridgePort = { first, ports };
}

/**
 * Opens a page of `origin` that holds the page channel. The injected API still works. The
 * test dApp's origin is served by the fixtures. Any other origin gets an empty page here.
 */
export async function openChannelPage(
  context: BrowserContext,
  origin: string = DAPP_ORIGIN
): Promise<Page> {
  if (origin !== DAPP_ORIGIN) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body>x</body></html>"
      })
    );
  }

  const page = await context.newPage();
  await page.addInitScript(keepBridgePort);
  await page.goto(origin);
  await page.waitForFunction(() => window.ergoConnector?.nautilus !== undefined);
  return page;
}

export type ChannelReply = { data: unknown } | { err: unknown };

/**
 * Sends a bridge message of the test's choosing from the page, over the port the injected
 * script uses, to `destination`, and resolves with the reply's `data` or `err`.
 */
export function sendOnChannel(
  page: Page,
  destination: "content-script" | "background" | "popup",
  messageID: string,
  data: unknown
): Promise<ChannelReply> {
  return page.evaluate(
    async ({ destination, messageID, data }) => {
      const { first, ports } = window.bridgePort;
      const port = await first;
      const transactionId = crypto.randomUUID();

      return new Promise<ChannelReply>((resolve) => {
        const done = (reply: ChannelReply) => {
          for (const p of ports) p.removeEventListener("message", onReply);
          resolve(reply);
        };
        const onReply = ({ data: m }: MessageEvent) => {
          if (m?.messageType === "reply" && m.transactionId === transactionId) {
            done(m.err === undefined ? { data: m.data } : { err: m.err });
          } else if (m?.type === "error" && m.transactionID === transactionId) {
            done({ err: "port failure" });
          }
        };

        for (const p of ports) p.addEventListener("message", onReply);
        port.postMessage({
          messageID,
          data,
          destination: { context: destination, tabId: null },
          messageType: "message",
          transactionId,
          origin: { context: "window", tabId: null },
          hops: [],
          timestamp: Date.now()
        });
      });
    },
    { destination, messageID, data }
  );
}

export type MultisigEntry =
  | { id: string; ok: true; request: string }
  | { id: string; ok: false; code: "declined" | "refused" | "unsupported"; message: string };

/** Runs `method` through the page's own API and records the answer or the rejection. */
export function runMultisig(
  page: Page,
  method: Method,
  items: { id: string; request: string }[]
): Promise<Outcome<MultisigEntry[]>> {
  return invoke(
    page,
    async ({ method, items }) => {
      const { multisig } = await window.ergoConnector.nautilus.getContext();
      return multisig[method](items);
    },
    { method, items }
  );
}

/**
 * `count` valid items. The ids and the request texts are words that must never show on the
 * review screen: the page chooses them. A request text passes the item checks, but no core
 * reads it.
 */
export function makeItems(count: number, tag: string, requestTag = tag) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tag}-${i + 1}`,
    request: `{"MSR":"${requestTag}-${i + 1}"}`
  }));
}

/**
 * What a declined run answers: one entry per item, in order, with exactly the fields of a run's
 * answer. The message is the wallet's own catalog text, so it went through the translation files.
 */
export const declined = (items: { id: string }[]) =>
  items.map(({ id }) => ({
    id,
    ok: false,
    code: "declined",
    message: catalog.connector.multisig.declined
  }));

/** The window's rows: one list item per item of the run. */
export const reviewRows = (win: Page) => win.getByRole("listitem");

/** The window's text outside the rows: the header, the count and the buttons. */
export function textOutsideRows(win: Page): Promise<string> {
  return win.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      if (text && !n.parentElement?.closest("li, [role=listitem]")) parts.push(text);
    }
    return parts.join(" ");
  });
}

/**
 * Starts `request`, which must open the review window, and returns the window and the pending
 * answer. A call that answers first fails the test with its answer: no window opened.
 */
export async function withReviewWindow<R>(context: BrowserContext, request: () => Promise<R>) {
  const opened = context.waitForEvent("page");
  opened.catch(() => undefined);
  const result = request();
  const win = await Promise.race([
    opened,
    result.then((answer) => {
      throw new Error(`The call answered before a window opened: ${JSON.stringify(answer)}`);
    })
  ]);
  await win.waitForURL(REVIEW_URL);

  return { win, result };
}

/** Collects every window opened from now on, in order. */
export function trackWindows(context: BrowserContext) {
  const windows: Page[] = [];
  context.on("page", (page) => windows.push(page));

  return {
    windows,
    /** Waits for the n-th (1-based) window. It may close at once, so no route is waited for. */
    async nth(n: number) {
      await expect
        .poll(() => windows.length, { message: `window ${n} opened` })
        .toBeGreaterThanOrEqual(n);
      return windows[n - 1];
    }
  };
}

type ChannelWorld = {
  msigChannel: { send(messageID: string, data: unknown): Promise<ChannelReply> };
};

/**
 * Runs in the isolated world of a page's content script. It opens a runtime port as a
 * content script does (the background takes the port of that tab's content script for the
 * channel) and keeps it open, so replies for several pending calls come back on it.
 */
function installChannel(fingerprint: string) {
  const waiting = new Map<string, (reply: ChannelReply) => void>();
  let port!: chrome.runtime.Port;

  const connect = () => {
    port = chrome.runtime.connect({ name: JSON.stringify({ endpointName: "", fingerprint }) });
    port.onDisconnect.addListener(connect);
    port.onMessage.addListener((m) => {
      if (m?.status !== "incoming" || m.message?.messageType !== "reply") return;

      const resolve = waiting.get(m.message.transactionId);
      if (!resolve) return;

      waiting.delete(m.message.transactionId);
      resolve(m.message.err === undefined ? { data: m.message.data } : { err: m.message.err });
    });
  };
  connect();

  (globalThis as unknown as ChannelWorld).msigChannel = {
    send: (messageID, data) =>
      new Promise((resolve) => {
        const transactionId = crypto.randomUUID();
        waiting.set(transactionId, resolve);
        port.postMessage({
          type: "deliver",
          message: {
            messageID,
            data,
            destination: { context: "background", tabId: null },
            messageType: "message",
            transactionId,
            origin: { context: "content-script", tabId: null },
            hops: [],
            timestamp: Date.now()
          }
        });
      })
  };
}

export type ContentScriptChannel = {
  /**
   * Sends a bridge message to the background as the content script of the channel page does,
   * and resolves with the reply's `data` or `err`. It resolves when the background answers,
   * so a call that waits for a window stays pending.
   */
  send(messageID: string, data: unknown): Promise<ChannelReply>;
};

/**
 * The content-script channel. Opens a second page of the test dApp, finds its content script's
 * isolated world by CDP, as `tests/e2e/connector/storage-access.spec.ts` does, and opens a
 * runtime port there. The test names `payload.origin` itself: the background takes the origin of
 * a content script's message as given. The page serves no other purpose, because the port takes
 * that tab's content script's place in the background's map.
 */
export async function openContentScriptChannel(
  context: BrowserContext,
  extensionId: string
): Promise<ContentScriptChannel> {
  const page = await context.newPage();
  await page.goto(DAPP_ORIGIN);

  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const contextIds: number[] = [];
  cdp.on("Runtime.executionContextCreated", ({ context: ctx }) => {
    const aux = ctx.auxData as { type?: string; frameId?: string } | undefined;
    if (
      ctx.origin === `chrome-extension://${extensionId}` &&
      aux?.type === "isolated" &&
      aux.frameId === frameTree.frame.id
    ) {
      contextIds.push(ctx.id);
    }
  });
  await cdp.send("Runtime.enable"); // reports the existing contexts
  await expect
    .poll(() => contextIds.length, { message: "the content script's world" })
    .toBeGreaterThan(0);

  const contextId = contextIds[0];
  const evaluate = async (expression: string) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      contextId,
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  const fingerprint = `uid::test${Math.random().toString(36).slice(2, 9)}`;
  await evaluate(`(${installChannel.toString()})(${JSON.stringify(fingerprint)})`);

  return {
    send: (messageID, data) =>
      evaluate(
        `globalThis.msigChannel.send(${JSON.stringify(messageID)}, ${JSON.stringify(data)})`
      ) as Promise<ChannelReply>
  };
}
