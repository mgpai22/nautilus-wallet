import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { connectDapp, invoke } from "../pages/connector";
import {
  BAD_RUNS,
  expectNoWindow,
  EXTERNAL,
  METHODS,
  openChannelPage,
  sendOnChannel,
  type Method
} from "./helpers";

declare global {
  interface Window {
    /** The context the page got after `connect()`, kept past a `disconnect()`. */
    keptContext: { multisig: Record<Method, (items: unknown) => Promise<unknown>> };
  }
}

/** Connects the channel page and keeps its context, as a page script can. */
async function connectAndKeep(context: BrowserContext, page: Page) {
  await connectDapp(context, page, WALLET_A.name);
  await page.evaluate(async () => {
    window.keptContext = await window.ergoConnector.nautilus.getContext();
  });
}

/**
 * Sends every bad run of the table under both names and expects the refusal of its row, as the
 * page's plain `{ code, info }` rejection or the relay's envelope, with no window.
 */
async function expectRefusals(context: BrowserContext, page: Page) {
  for (const method of METHODS) {
    for (const row of BAD_RUNS) {
      const error = { code: -1, info: row.info };
      const label = `${method}: ${row.name}`;

      if ("items" in row) {
        const outcome = await expectNoWindow(context, page, () =>
          invoke(page, ({ method, items }) => window.keptContext.multisig[method](items), {
            method,
            items: row.items
          })
        );
        expect(outcome, label).toEqual({ ok: false, error });
      } else {
        const reply = await expectNoWindow(context, page, () =>
          sendOnChannel(page, "content-script", EXTERNAL[method], row.data)
        );
        expect(reply, label).toEqual({ data: { success: false, error } });
      }
    }

    // An empty slot of a sparse list, which MessagePort keeps, is not skipped by map and then thrown
    // on as an Error. The list is made in the page: from Node, a hole becomes undefined.
    const sparse = await expectNoWindow(context, page, () =>
      invoke(page, (method) => window.keptContext.multisig[method](Array(1)), method)
    );
    expect(sparse, `${method}: a sparse list`).toEqual({
      ok: false,
      error: { code: -1, info: "Invalid id." }
    });
  }
}

test.describe("multisig run refusals at the relay", () => {
  test.beforeEach(async ({ popup }) => {
    await popup.importWallet(WALLET_A);
  });

  // A refusal reaches the page as its own `{ code, info }`, never as an Error, with another check's
  // text or after a window opened, and the limits hold exactly: 21 items, a 65-character id or a
  // 1,000,001-character request is refused.
  test("a connected page gets each item check's refusal and no window", async ({ context }) => {
    const page = await openChannelPage(context);
    await connectAndKeep(context, page);

    await expectRefusals(context, page);
  });

  // The relay refuses a bad run itself and checks characters as well as lengths, so the call gets
  // its own text instead of dying at the background or at the runtime port's size limit.
  test("a page that disconnected still gets each item check's own refusal", async ({ context }) => {
    const page = await openChannelPage(context);
    await connectAndKeep(context, page);
    expect(await invoke(page, () => window.ergoConnector.nautilus.disconnect())).toEqual({
      ok: true,
      value: true
    });

    await expectRefusals(context, page);
  });
});
