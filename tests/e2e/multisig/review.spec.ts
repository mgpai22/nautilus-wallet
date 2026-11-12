import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { DAPP_HOST } from "../mocks/services";
import { clickToClose, connectDapp, expectRequestFrom, invoke } from "../pages/connector";
import {
  APPROVE,
  declined,
  DECLINE,
  makeItems,
  METHODS,
  reviewRows,
  runMultisig,
  textOutsideRows,
  trackWindows,
  withReviewWindow
} from "./helpers";

test.describe("multisig run in the review window", () => {
  test.beforeEach(async ({ popup, context, dapp }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // The review names a commit run and a sign run apart and never shows either as a plain
  // transaction signature. The page's own words (an id, a request text) are never shown as fact.
  // These requests are due for commitments: the commit run offers Approve, and the sign run
  // refuses them as not due, so it offers none.
  test("shows the origin, the step in plain words and one row per item, and approves a commit run only", async ({
    context,
    dapp
  }) => {
    const items = makeItems(3, "payroll");
    const headers: Record<string, string> = {};

    for (const method of METHODS) {
      const { win, result } = await withReviewWindow(context, () =>
        runMultisig(dapp, method, items)
      );
      await expectRequestFrom(win, DAPP_HOST);

      const rows = reviewRows(win);
      await expect(rows).toHaveCount(3);
      for (const [i, row] of (await rows.all()).entries()) {
        await expect(row).toContainText(String(i + 1));
      }

      const header = await textOutsideRows(win);
      headers[method] = header;
      expect(header).toMatch(/\b3 transactions/);
      expect(header).not.toMatch(/sign a transaction/i);
      expect(header).not.toMatch(method === "commit" ? /\bsign/i : /commit/i);
      expect(header).toMatch(method === "commit" ? /commit/i : /\bsign/i);

      // the page chooses an id: it is no fact the signer can rely on
      expect(await win.locator("body").innerText()).not.toContain("payroll");

      // the requests are due for commitments: a commit run offers Approve, a sign run only Decline
      await expect(win.getByRole("button", { name: DECLINE })).toBeVisible();
      await expect(win.getByRole("button", { name: APPROVE })).toHaveCount(
        method === "commit" ? 1 : 0
      );

      await clickToClose(win.getByRole("button", { name: DECLINE }));
      await result;
    }

    expect(headers.commit).not.toBe(headers.sign);
  });

  // The answer is one entry per item, in order, with the run's own fields, never sign_tx's
  // { code: 2 } rejection.
  test("decline answers every item as declined, in order, and closes the window", async ({
    context,
    dapp
  }) => {
    const items = makeItems(3, "payroll");
    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );

    await clickToClose(win.getByRole("button", { name: DECLINE }));

    expect(await result).toEqual({ ok: true, value: declined(items) });
    expect(win.isClosed()).toBe(true);
  });

  // A closed window answers every item as declined: it never rejects with "Connector window
  // closed." and never leaves the page waiting.
  test("a closed window answers every item as declined", async ({ context, dapp }) => {
    const items = makeItems(3, "payroll");
    // the items are due for a commitment: in a sign run the review would stop them as not due
    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await expect(reviewRows(win)).toHaveCount(3);

    await win.close({ runBeforeUnload: true });

    expect(await result).toEqual({ ok: true, value: declined(items) });
  });

  // A run at the limits passes every hop: a hop that dies on a 40 MB message, or an off-by-one that
  // refuses a run at the limits, fails here. The refusal tests send runs one past each limit only.
  test("a run at every limit reaches the window and every item is answered with its id", async ({
    context,
    dapp
  }) => {
    test.setTimeout(180_000);
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(64, "0"));
    const { win, result } = await withReviewWindow(context, () =>
      invoke(
        dapp,
        async (ids) => {
          // JSON doubles a backslash, so each request is 2,000,000 bytes on the wire and the
          // run is about 40 MB. One request holds line breaks too, and so is as long.
          const text = "\\".repeat(1_000_000);
          const lines = ("\\".repeat(79) + "\n").repeat(12_500);
          const items = ids.map((id, i) => ({ id, request: i === 7 ? lines : text }));

          const { multisig } = await window.ergoConnector.nautilus.getContext();
          return multisig.commit(items);
        },
        ids
      )
    );

    await expect(reviewRows(win)).toHaveCount(20);
    await clickToClose(win.getByRole("button", { name: DECLINE }));

    // none of the 20 texts is a request: each item is stopped with the core's reason
    expect(await result).toEqual({
      ok: true,
      value: ids.map((id) => ({
        id,
        ok: false,
        code: "unsupported",
        message: expect.stringMatching(/^C5: /)
      }))
    });
  });

  // Two runs with the same ids but other request texts must not share an answer, as a dedupe hash
  // over the ids alone would make them.
  test("shares a window between identical runs and gives another run its own", async ({
    context,
    dapp
  }) => {
    const tracker = trackWindows(context);
    const items = makeItems(2, "payroll");
    const other = makeItems(2, "payroll");

    const { win, result: first } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    const second = runMultisig(dapp, "commit", items);
    const third = runMultisig(dapp, "commit", other);
    await dapp.evaluate(() => window.ergoConnector.nautilus.isAuthorized());

    await clickToClose(win.getByRole("button", { name: DECLINE }));
    expect(await first).toEqual({ ok: true, value: declined(items) });
    expect(await second).toEqual({ ok: true, value: declined(items) });

    const next = await tracker.nth(2);
    await next.waitForURL(/\/connector\/index\.html#\/multisig$/);
    await expect(reviewRows(next)).toHaveCount(2);
    await clickToClose(next.getByRole("button", { name: DECLINE }));

    expect(await third).toEqual({ ok: true, value: declined(other) });
    expect(tracker.windows).toHaveLength(2);
  });

  // A relay or background must not pass a legal run on from a page whose connection is gone.
  test("a page that disconnected gets Not connected. and no window", async ({ context, dapp }) => {
    const tracker = trackWindows(context);
    expect(
      await invoke(
        dapp,
        async (items) => {
          const ctx = await window.ergoConnector.nautilus.getContext();
          await window.ergoConnector.nautilus.disconnect();
          return ctx.multisig.commit(items);
        },
        makeItems(1, "payroll")
      )
    ).toEqual({ ok: false, error: { code: -1, info: "Not connected." } });

    await dapp.evaluate(() => window.ergoConnector.nautilus.isAuthorized());
    expect(tracker.windows).toHaveLength(0);
  });

  // The review must not show the run of an origin that was disconnected while the run waited
  // behind another window.
  test("a queued run whose origin disconnected gets Unauthorized. and its window closes", async ({
    context,
    dapp
  }) => {
    const tracker = trackWindows(context);
    const { win, result: first } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", makeItems(1, "payroll"))
    );
    const queued = runMultisig(dapp, "sign", makeItems(1, "payroll"));
    // the queued run has passed the background's connection check once this answers
    await dapp.evaluate(() => window.ergoConnector.nautilus.isAuthorized());
    expect(await invoke(dapp, () => window.ergoConnector.nautilus.disconnect())).toEqual({
      ok: true,
      value: true
    });

    await clickToClose(win.getByRole("button", { name: DECLINE }));
    expect(await first).toEqual({ ok: true, value: declined(makeItems(1, "payroll")) });

    const next = await tracker.nth(2);
    await expect.poll(() => next.isClosed(), { message: "the second window closes" }).toBe(true);
    expect(await queued).toEqual({ ok: false, error: { code: -3, info: "Unauthorized." } });
  });
});
