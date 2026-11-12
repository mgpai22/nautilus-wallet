import { expect, test } from "../fixtures/test";
import { RECIPIENT_ADDRESS, TEST_TOKEN, WALLET_A } from "../fixtures/wallets";
import { GRAPHQL_URLS } from "../mocks/chain";
import { toast } from "../pages/common";
import { clickToClose, connectDapp } from "../pages/connector";
import {
  APPROVE,
  approveButton,
  DECLINE,
  declined,
  holdRunAtSecondItem,
  latch,
  nonceKeys,
  nonceRecords,
  nonceTxIds,
  passwordField,
  releaseHold,
  reviewRows,
  runMultisig,
  withReviewWindow,
  type MultisigEntry
} from "./helpers";
import {
  cellsOf,
  columnOf,
  makeRequest,
  makeWallet,
  publicKeyOf,
  unpackCsr,
  unpackMsr,
  type MultisigWallet
} from "./requests";

/** A cell of a commitment: a compressed curve point. */
const COMMITMENT_BYTES = 33;

/**
 * One 2 of 3 request per entry of `inputCounts`, each with its own co-signers and with Alice
 * (the connected wallet, index 0) as the signer, and the items a page sends for them.
 */
async function buildItems(inputCounts: number[]) {
  const signer = await publicKeyOf(WALLET_A, 0);
  const built = inputCounts.map((inputs) => {
    const wallet = makeWallet(2, 3, signer);
    return { wallet, ...makeRequest(wallet, inputs) };
  });
  const items = built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr }));

  return { signer, built, items, txIds: built.map(({ txId }) => txId).sort() };
}

type Built = { wallet: MultisigWallet };

/**
 * One answer of a commit run, judged by the test's own decoder: exactly the fields of a run's
 * answer, an MSR whose `tx` and `boxes` are the request's, and per input exactly one cell
 * that is not empty, this signer's, of 33 bytes.
 */
function expectCommitted(
  entry: MultisigEntry,
  item: { id: string; request: string },
  { wallet }: Built,
  signer: Uint8Array
) {
  expect(Object.keys(entry).sort(), `fields of ${item.id}`).toEqual(["id", "ok", "request"]);
  if (!entry.ok) throw new Error(`${item.id} was not committed: ${entry.code}`);
  expect(entry.id).toBe(item.id);

  const csr = unpackCsr(item.request);
  const msr = unpackMsr(entry.request);
  expect(msr.outerKeys).toEqual(["MSR"]);
  expect(msr.innerKeys).toEqual(["boxes", "hints", "tx"]);
  expect(msr.tx).toBe(csr.reducedTx);
  expect(msr.boxes).toEqual(csr.inputs);

  const column = columnOf(wallet, signer);
  expect(cellsOf(entry.request).map((row) => row.map((cell) => cell.length))).toEqual(
    csr.inputs.map(() => wallet.keys.map((_, j) => (j === column ? COMMITMENT_BYTES : 0)))
  );
}

test.describe("multisig commit run", () => {
  test.beforeEach(async ({ popup, context, dapp, chain }) => {
    chain.addToken(TEST_TOKEN);
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // The commitment goes in this signer's column only: no co-signer's cell changes, no CSR comes
  // back, no field rides beside id, ok and request, the password is asked once, and the record is
  // stored before the answer leaves.
  test("three 2 of 3 items are committed after one password, in this signer's cell only", async ({
    context,
    dapp
  }) => {
    const { signer, built, items, txIds } = await buildItems([1, 2, 3]);

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await expect(reviewRows(win)).toHaveCount(3);
    await expect(approveButton(win)).toBeVisible();

    // one field for the whole run, filled once
    await expect(passwordField(win)).toHaveCount(1);
    await passwordField(win).fill(WALLET_A.password);
    await clickToClose(approveButton(win));

    const outcome = await result;
    if (!outcome.ok) throw new Error("The call was rejected.");
    expect(outcome.value).toHaveLength(3);
    for (const [i, entry] of outcome.value.entries()) {
      expectCommitted(entry, items[i], built[i], signer);
    }
    // each record is stored before its commitment leaves: one per transaction
    expect(await nonceTxIds(context)).toEqual(txIds);
  });

  // A review that fills in place (a token's name and scale arriving after the first reading)
  // restarts the wait, so a click aimed at the old text cannot approve the new one.
  test("the approve control is disabled on opening and after the review changes, and works a second after each", async ({
    context,
    dapp
  }) => {
    const { items } = await buildItems([1]);
    // a payment that carries a token: its name and decimals arrive from the chain after the reading
    const signer = await publicKeyOf(WALLET_A, 0);
    const wallet = makeWallet(2, 3, signer);
    items[0] = {
      id: "payroll-1",
      request: makeRequest(wallet, 1, {
        address: RECIPIENT_ADDRESS,
        value: 123_456_789n,
        tokens: [{ id: TEST_TOKEN.tokenId, amount: 12_345n }]
      }).csr
    };

    // the window's request for the token's metadata is held until the test lets it go
    const asked = latch();
    const gate = latch();
    for (const url of GRAPHQL_URLS) {
      await context.route(url, async (route) => {
        const body = route.request().postDataJSON() as { operationName?: string } | null;
        if (body?.operationName === "Tokens") {
          asked.open();
          await gate.opened;
        }
        await route.fallback();
      });
    }

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );

    // the state of the control in the first frame that holds it
    const first = await win.waitForFunction(
      (label) => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === label
        );
        return button ? { disabled: button.disabled } : null;
      },
      APPROVE,
      { timeout: 5_000 }
    );
    expect(await first.jsonValue()).toEqual({ disabled: true });

    await asked.opened;
    await expect(reviewRows(win).first()).not.toContainText(TEST_TOKEN.name);
    await expect(approveButton(win)).toBeEnabled();

    // the control is disabled in the turn in which the review changes, not later
    await win.evaluate(
      ({ name, label }) => {
        const world = window as unknown as { disabledAtChange: Promise<boolean> };
        let report!: (disabled: boolean) => void;
        world.disabledAtChange = new Promise<boolean>((resolve) => (report = resolve));
        const watch = new MutationObserver(async () => {
          if (!document.body.innerText.includes(name)) return;
          watch.disconnect();
          // one turn for the framework to settle, as upstream's own delay test does
          await new Promise<void>((resolve) => setTimeout(resolve));
          const button = [...document.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === label
          );
          report(button?.disabled === true);
        });
        watch.observe(document.body, { subtree: true, childList: true, characterData: true });
      },
      { name: TEST_TOKEN.name, label: APPROVE }
    );
    gate.open();
    expect(
      await win.evaluate(() => {
        const world = window as unknown as { disabledAtChange: Promise<boolean> };
        return world.disabledAtChange;
      })
    ).toBe(true);
    await expect(reviewRows(win).first()).toContainText(TEST_TOKEN.name);
    await expect(approveButton(win)).toBeEnabled();

    await clickToClose(win.getByRole("button", { name: DECLINE }));
    expect(await result).toEqual({ ok: true, value: declined(items) });
  });

  // A wrong password neither answers the page, closes the window nor leaves a record, and the right
  // password afterwards completes the run.
  test("a wrong password keeps the window, answers nothing and stores nothing, and the right one completes the run", async ({
    context,
    dapp
  }) => {
    const { signer, built, items, txIds } = await buildItems([1, 2]);

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await expect(approveButton(win)).toBeVisible();

    // a settlement flag set the moment the call's promise settles, from before the click
    let settled = false;
    result.then(
      () => (settled = true),
      () => (settled = true)
    );
    await passwordField(win).fill("wrong password");
    await approveButton(win).click();
    await expect(toast(win, `Wrong "${WALLET_A.name}" password`)).toBeVisible();

    expect(win.isClosed()).toBe(false);
    expect(await nonceKeys(context)).toEqual([]);
    expect(settled, "the call has no answer after a wrong password").toBe(false);
    await passwordField(win).fill(WALLET_A.password);
    await clickToClose(approveButton(win));

    const outcome = await result;
    if (!outcome.ok) throw new Error("The call was rejected.");
    expect(outcome.value).toHaveLength(2);
    for (const [i, entry] of outcome.value.entries()) {
      expectCommitted(entry, items[i], built[i], signer);
    }
    expect(await nonceTxIds(context)).toEqual(txIds);
  });

  // A second commit of the same items draws no new nonce for a leaf whose commitment already left,
  // so the page gets the same commitments and the item is not refused.
  test("the same commit call sent again returns the same requests and stores no new record", async ({
    context,
    dapp
  }) => {
    const { signer, built, items, txIds } = await buildItems([1, 2]);

    const run = async () => {
      const { win, result } = await withReviewWindow(context, () =>
        runMultisig(dapp, "commit", items)
      );
      await expect(approveButton(win)).toBeVisible();
      await passwordField(win).fill(WALLET_A.password);
      await clickToClose(approveButton(win));

      const outcome = await result;
      if (!outcome.ok) throw new Error("The call was rejected.");
      return outcome.value;
    };

    const answers = await run();
    for (const [i, entry] of answers.entries()) {
      expectCommitted(entry, items[i], built[i], signer);
    }
    const keys = await nonceKeys(context);
    const records = await nonceRecords(context);
    expect(keys).toHaveLength(items.length);

    const again = await run();
    expect(again).toEqual(answers);
    expect(await nonceKeys(context)).toEqual(keys);
    expect(await nonceTxIds(context)).toEqual(txIds);
    // the stored text is the one the first run wrote: no record was written again
    expect(Object.entries(await nonceRecords(context)).every(([k, v]) => records[k] === v)).toBe(
      true
    );
  });

  // Closing the window in the middle of a run returns the full list with the finished result, or
  // rejects the call. Retrying reuses the finished item's nonce and completes the remaining items.
  test("a window closed during a run answers the finished item and declines the rest, and the same call again succeeds", async ({
    context,
    dapp,
    popup
  }, testInfo) => {
    const { signer, built, items, txIds } = await buildItems([1, 1, 1]);

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await expect(approveButton(win)).toBeVisible();

    // the first row is done, the second at work, and the third has not started
    const hold = await holdRunAtSecondItem(win, popup.page, WALLET_A.password);
    expect(await nonceTxIds(context)).toEqual([built[0].txId]);
    const stored = await nonceRecords(context);

    await win.close({ runBeforeUnload: true });
    const closed = await result;

    // exactly two outcomes pass: the list with the finished item, or the call's error
    let finished: string | undefined;
    // the report names which of the two outcomes Chrome gave
    testInfo.annotations.push({
      type: "outcome",
      description: closed.ok ? "answered with a list" : "rejected with an error"
    });
    if (closed.ok) {
      expect(closed.value).toHaveLength(3);
      expectCommitted(closed.value[0], items[0], built[0], signer);
      expect(closed.value.slice(1)).toEqual(declined(items.slice(1)));
      const [entry] = closed.value;
      finished = entry.ok ? entry.request : undefined;
    } else {
      expect(closed.error).toEqual({ message: expect.any(String) });
    }

    // the window is gone: the held write cannot reach storage once the hold goes
    await releaseHold(popup.page, hold);
    expect(await nonceTxIds(context)).toEqual([built[0].txId]);

    const retry = await withReviewWindow(context, () => runMultisig(dapp, "commit", items));
    await expect(approveButton(retry.win)).toBeVisible();
    await passwordField(retry.win).fill(WALLET_A.password);
    await clickToClose(approveButton(retry.win));

    const again = await retry.result;
    if (!again.ok) throw new Error("The call was rejected.");
    expect(again.value).toHaveLength(3);
    for (const [i, entry] of again.value.entries()) {
      expectCommitted(entry, items[i], built[i], signer);
    }
    // the finished item's request is the same, and its record is the one the first run wrote
    const [entry] = again.value;
    if (finished !== undefined) expect(entry.ok && entry.request === finished).toBe(true);
    const after = await nonceRecords(context);
    const [firstKey] = Object.keys(stored);
    expect(after[firstKey] === stored[firstKey]).toBe(true);
    expect(await nonceTxIds(context)).toEqual(txIds);
  });
});
