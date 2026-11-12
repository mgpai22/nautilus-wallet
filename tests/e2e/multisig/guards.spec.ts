import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { DAPP_HOST, DAPP_ORIGIN } from "../mocks/services";
import { clickToClose, connectDapp, expectRequestFrom } from "../pages/connector";
import {
  BAD_RUNS,
  declined,
  DECLINE,
  expectNoWindow,
  EXTERNAL,
  INTERNAL,
  makeItems,
  METHODS,
  openChannelPage,
  openContentScriptChannel,
  reviewRows,
  runMultisig,
  sendOnChannel,
  textOutsideRows,
  trackWindows,
  withReviewWindow
} from "./helpers";

const ATTACKER_ORIGIN = "https://attacker.test";
const payload = { origin: DAPP_ORIGIN };

test.describe("multisig run guards behind the relay", () => {
  test.beforeEach(async ({ popup, context, dapp }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // A background that trusts the relay would take a bad run from a content script as it is. A page
  // cannot send these, so only this test reaches the background's own checks.
  test("the background checks every run again and opens no window", async ({
    context,
    dapp,
    extensionId
  }) => {
    const channel = await openContentScriptChannel(context, extensionId);

    for (const method of METHODS) {
      for (const row of BAD_RUNS) {
        let data: object;
        if ("items" in row) data = { items: row.items, payload };
        // the background reads `payload.origin` before any handler runs, so data that is no
        // object is refused by the relay alone
        else if (typeof row.data === "object" && row.data !== null) data = { ...row.data, payload };
        else continue;

        const reply = await expectNoWindow(context, dapp, () =>
          channel.send(INTERNAL[method], data)
        );

        expect(reply, `${method}: ${row.name}`).toEqual({
          data: { success: false, error: { code: -1, info: row.info } }
        });
      }
    }
  });

  // The background builds the items anew and passes nothing else of `msg.data` on, so a stray
  // field never reaches the window or splits two identical runs into two windows. The relay builds
  // items anew too, so only this test reaches the background's own copy.
  test("builds the items anew, so a stray field neither travels nor splits a run", async ({
    context,
    dapp,
    extensionId
  }) => {
    const channel = await openContentScriptChannel(context, extensionId);
    const tracker = trackWindows(context);
    const items = makeItems(2, "payroll");

    const { win, result: first } = await withReviewWindow(context, () =>
      channel.send(INTERNAL.commit, { items, payload })
    );
    const strayItems = items.map((item, i) => (i === 0 ? { ...item, stray: "x" } : item));
    let secondDone = false;
    const second = channel
      .send(INTERNAL.commit, { items: strayItems, stray: "y", payload })
      .finally(() => (secondDone = true));
    await dapp.evaluate(() => window.ergoConnector.nautilus.isAuthorized());

    await clickToClose(win.getByRole("button", { name: DECLINE }));

    const answer = { data: { success: true, data: declined(items) } };
    expect(await first).toEqual(answer);
    await expect.poll(() => secondDone, { message: "the second run is answered" }).toBe(true);
    expect(await second).toEqual(answer);
    expect(tracker.windows).toHaveLength(1);
  });

  // The relay sets `payload` itself, so the page's own value never wins, and the handler checks for
  // an internal sender, so a page cannot reach around the relay.
  test("a page cannot name another origin or go around the relay", async ({ context }) => {
    const attacker = await openChannelPage(context, ATTACKER_ORIGIN);
    const items = makeItems(1, "payroll");
    const notConnected = {
      data: { success: false, error: { code: -1, info: "Not connected." } }
    };

    for (const method of METHODS) {
      const throughRelay = await expectNoWindow(context, attacker, () =>
        sendOnChannel(attacker, "content-script", EXTERNAL[method], { items, payload })
      );
      expect(throughRelay, `${method}: through the relay`).toEqual(notConnected);

      const aroundRelay = await expectNoWindow(context, attacker, () =>
        sendOnChannel(attacker, "background", INTERNAL[method], { items, payload })
      );
      expect(aroundRelay, `${method}: around the relay`).toEqual(notConnected);
    }
  });

  // The window handler takes messages from the background only, so a page cannot hand the open
  // window a run of its own through the shared popup endpoint.
  test("a page cannot hand the open window another run", async ({ context, dapp }) => {
    const channel = await openChannelPage(context);
    const items = makeItems(3, "payroll");
    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await expectRequestFrom(win, DAPP_HOST);
    await expect(reviewRows(win)).toHaveCount(3);

    const forged = { items: makeItems(1, "forged"), payload: { origin: "https://forged.test" } };
    for (const method of METHODS) {
      expect(await sendOnChannel(channel, "popup", INTERNAL[method], forged), method).toEqual({
        err: expect.objectContaining({ message: "Unauthorized sender." })
      });
    }

    await expectRequestFrom(win, DAPP_HOST);
    await expect(reviewRows(win)).toHaveCount(3);
    expect(await textOutsideRows(win)).not.toContain("forged.test");

    await clickToClose(win.getByRole("button", { name: DECLINE }));
    expect(await result).toEqual({ ok: true, value: declined(items) });
  });
});
