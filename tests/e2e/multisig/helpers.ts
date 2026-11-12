import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ErgoHDKey } from "@fleet-sdk/wallet";
import { WALLET_A } from "../fixtures/wallets";
import { DAPP_ORIGIN } from "../mocks/services";
import { clickToClose, invoke, type Outcome } from "../pages/connector";
import { cellsOf, makeRequest, makeWallet, unpackCsr, unpackMsr } from "./requests";

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

/** Alice's key at index 0: the signer of every request `makeItems` builds, and the wallet each spec connects. */
const ALICE = ErgoHDKey.fromMnemonicSync(WALLET_A.mnemonic).deriveChild(0).publicKey;

/**
 * `count` items that the review reads: each a 2 of 3 request with Alice as one signer, due for
 * a commitment. The ids are words that must never show on the review screen: the page chooses
 * them. Every call makes new requests.
 */
export function makeItems(count: number, tag: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tag}-${i + 1}`,
    request: makeRequest(makeWallet(2, 3, ALICE), 1).csr
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

/**
 * A raw amount as the window shows it: scaled by `decimals`, with no trailing zeros. The
 * amounts of these tests stay below 1,000, so the wallet's digit grouping never applies.
 */
export function decimalText(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const whole = digits.slice(0, digits.length - decimals);
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The window texts that the tests fix as its contract: the approve control, and the two row
 * states of a run. The catalog holds them in English.
 */
export const APPROVE = "Approve";
export const STATE_WORKING = "Working";
export const STATE_DONE = "Done";

export const approveButton = (win: Page) => win.getByRole("button", { name: APPROVE, exact: true });

/** The one password field of a wallet with its own password: its label ends in "password". */
export const passwordField = (win: Page) => win.getByRole("textbox", { name: / password$/ });

/** A row of the window shows the state `state` as a text of its own. */
export const rowState = (row: Locator, state: string) => row.getByText(state, { exact: true });

async function localStorageOf(context: BrowserContext): Promise<Record<string, unknown>> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return worker.evaluate(() => chrome.storage.local.get());
}

const NONCE_PREFIX = "msigNonce:";

/** The storage keys of the nonce records, as the service worker reads storage. Never a value. */
export async function nonceKeys(context: BrowserContext): Promise<string[]> {
  const stored = await localStorageOf(context);
  return Object.keys(stored)
    .filter((key) => key.startsWith(NONCE_PREFIX))
    .sort();
}

/** The transaction ids of the nonce records: the last part of each storage key, sorted. */
export async function nonceTxIds(context: BrowserContext): Promise<string[]> {
  return (await nonceKeys(context)).map((key) => key.split(":").at(-1) ?? "").sort();
}

/**
 * The stored text of every nonce record, to compare two readings. The text is encrypted. It is
 * only ever compared with `sameRecords`, never printed or kept in a failure message.
 */
export async function nonceRecords(context: BrowserContext): Promise<Record<string, string>> {
  const stored = await localStorageOf(context);
  return Object.fromEntries(
    Object.entries(stored)
      .filter(([key]) => key.startsWith(NONCE_PREFIX))
      .map(([key, value]) => [key, JSON.stringify(value)])
  );
}

/** Whether two readings of `nonceRecords` are one and the same, as a boolean. */
export function sameRecords(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) &&
    keys.every((key) => a[key] === b[key])
  );
}

/**
 * The Web Lock the nonce store takes for every write. Every page of the extension shares it, so
 * a page of the test can hold it while the window works.
 */
const NONCE_LOCK = "nautilus:msig-nonces";

type HoldWorld = {
  msigHolds?: Map<number, { granted: Promise<void>; release(): void }>;
};

/** A promise and the call that resolves it, for a test that waits on something it releases. */
export function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Asks `page` for the nonce lock and resolves at once with the hold's id, before it is granted. */
export function queueHold(page: Page): Promise<number> {
  return page.evaluate((name) => {
    const world = globalThis as unknown as HoldWorld;
    const holds = (world.msigHolds ??= new Map());
    const id = holds.size + 1;
    let grant!: () => void;
    let letGo!: () => void;
    const granted = new Promise<void>((resolve) => (grant = resolve));
    const released = new Promise<void>((resolve) => (letGo = resolve));
    void navigator.locks.request(name, () => {
      grant();
      return released;
    });
    holds.set(id, { granted, release: () => letGo() });
    return id;
  }, NONCE_LOCK);
}

/** Resolves when the lock is granted to the hold `id` of `page`. */
export function holdGranted(page: Page, id: number): Promise<void> {
  return page.evaluate(
    (id) => (globalThis as unknown as HoldWorld).msigHolds!.get(id)!.granted,
    id
  );
}

/** Lets the hold `id` of `page` go. The next request in the lock's queue is granted. */
export async function releaseHold(page: Page, id: number): Promise<void> {
  await page.evaluate(
    (id) => (globalThis as unknown as HoldWorld).msigHolds!.get(id)!.release(),
    id
  );
}

/** The number of requests for the nonce lock that wait behind a holder. */
export function waitingForLock(page: Page): Promise<number> {
  return page.evaluate(
    async (name) =>
      ((await navigator.locks.query()).pending ?? []).filter((request) => request.name === name)
        .length,
    NONCE_LOCK
  );
}

/**
 * Holds a run of more than `finished` items with that many items done, the next one at work and
 * the others not started, and resolves with the hold that keeps it there. `lockPage` is a page of
 * the extension that is not the window. The run is held by the nonce lock alone: the test holds
 * it, queues the next hold behind the working item's write, and lets only that write through.
 * No time decides the result. The first row is at work while the first hold stands.
 */
export async function holdRunAfter(
  win: Page,
  lockPage: Page,
  password: string,
  finished: number,
  timeout = 60_000
) {
  let hold = await queueHold(lockPage);
  await holdGranted(lockPage, hold);

  await passwordField(win).fill(password);
  await approveButton(win).click();
  // the first item's write waits behind the hold
  await expect.poll(() => waitingForLock(lockPage), { timeout }).toBe(1);
  await expect(rowState(reviewRows(win).first(), STATE_WORKING)).toBeVisible({ timeout });

  for (let done = 1; done <= finished; done++) {
    // the next hold queues behind that write, so the next item's write queues behind the hold
    const next = await queueHold(lockPage);
    await expect.poll(() => waitingForLock(lockPage), { timeout }).toBe(2);
    await releaseHold(lockPage, hold);
    await holdGranted(lockPage, next);

    await expect(rowState(reviewRows(win).nth(done - 1), STATE_DONE)).toBeVisible({ timeout });
    await expect(rowState(reviewRows(win).nth(done), STATE_WORKING)).toBeVisible({ timeout });
    await expect.poll(() => waitingForLock(lockPage), { timeout }).toBe(1);
    hold = next;
  }

  return hold;
}

/** The first row done, the second at work and the others not started: `holdRunAfter` one item. */
export const holdRunAtSecondItem = (win: Page, lockPage: Page, password: string) =>
  holdRunAfter(win, lockPage, password, 1);

/**
 * One run through the window as a signer takes it: the password, Approve, and the page's answer.
 * A run the page could not answer fails the test.
 */
export async function approvedRun(
  context: BrowserContext,
  dapp: Page,
  method: Method,
  items: { id: string; request: string }[],
  password: string,
  timeout = 10_000
) {
  const { win, result } = await withReviewWindow(context, () => runMultisig(dapp, method, items));
  await expect(approveButton(win), `the ${method} run offers Approve`).toBeVisible({ timeout });
  await passwordField(win).fill(password);
  await clickToClose(approveButton(win));

  const outcome = await result;
  if (!outcome.ok) throw new Error(`The ${method} call was rejected.`);
  return outcome.value;
}

/** The text of an answer's request, or a failure that names the item and its code. */
export function requestOf(entry: MultisigEntry): string {
  if (!entry.ok) throw new Error(`${entry.id} gave no request: ${entry.code}`);
  return entry.request;
}

/**
 * Removes the nonce record of one transaction, as the service worker reaches storage. A test
 * does this to make a record the wallet lost.
 */
export async function removeNonceRecord(context: BrowserContext, txId: string): Promise<void> {
  const keys = (await nonceKeys(context)).filter((key) => key.endsWith(`:${txId}`));
  expect(keys, `the records of ${txId}`).toHaveLength(1);

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate((keys) => chrome.storage.local.remove(keys), keys);
}

/** The sizes a cell of a Minotaur request can have: empty, a commitment, a response, a simulated response. */
const CELL_BYTES = [0, 33, 89, 90];

/**
 * One answer of a run, judged as a page sees it: exactly the fields `id`, `ok` and `request`, an
 * MSR that holds `tx`, `boxes` and `hints` and nothing else, and every cell of a length a
 * Minotaur request allows. No nonce can ride in a field or a cell of another size.
 * `item` is the request that was sent: `tx` and `boxes` stay as they were.
 */
export function expectAnswerShape(entry: MultisigEntry, item: { id: string; request: string }) {
  expect(Object.keys(entry).sort(), `fields of ${item.id}`).toEqual(["id", "ok", "request"]);
  const request = requestOf(entry);
  const msr = unpackMsr(request);
  expect(entry.id).toBe(item.id);
  expect(msr.outerKeys).toEqual(["MSR"]);
  expect(msr.innerKeys).toEqual(["boxes", "hints", "tx"]);

  const sent = item.request.includes('"CSR"') ? unpackCsr(item.request) : unpackMsr(item.request);
  expect(msr.tx === ("reducedTx" in sent ? sent.reducedTx : sent.tx), "tx is unchanged").toBe(true);
  expect(
    JSON.stringify(msr.boxes) === JSON.stringify("inputs" in sent ? sent.inputs : sent.boxes),
    "boxes are unchanged"
  ).toBe(true);
  expect(
    cellsOf(request)
      .flatMap((row) => row.map((cell) => cell.length))
      .filter((length) => !CELL_BYTES.includes(length)),
    `cell lengths of ${item.id} outside ${CELL_BYTES}`
  ).toEqual([]);
}
