import { expect, type BrowserContext, type Page } from "@playwright/test";
import { DAPP_ORIGIN } from "../mocks/services";

export type Method = "commit" | "sign";
export const METHODS: Method[] = ["commit", "sign"];

/** The external request names. Tests cannot import the const enum. */
export const EXTERNAL: Record<Method, string> = {
  commit: "ext:multisig-commit",
  sign: "ext:multisig-sign"
};

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
 * follows the call, so a window the background opened late is seen too.
 */
export async function expectNoWindow<R>(
  context: BrowserContext,
  page: Page,
  call: () => Promise<R>
): Promise<R> {
  const opened: string[] = [];
  const onPage = (p: Page) => opened.push(p.url());
  context.on("page", onPage);
  try {
    const result = await call();
    await page.evaluate(() => window.ergoConnector.nautilus.isAuthorized());
    expect(opened, "windows opened").toEqual([]);
    return result;
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

/** Opens the test dApp in a new page that holds the page channel. The injected API still works. */
export async function openChannelPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(keepBridgePort);
  await page.goto(DAPP_ORIGIN);
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
