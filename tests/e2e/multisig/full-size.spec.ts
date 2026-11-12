import { expect, test } from "../fixtures/test";
import { RECIPIENT_ADDRESS, WALLET_A } from "../fixtures/wallets";
import { connectDapp } from "../pages/connector";
import { cosignerCommit, cosignerSign, verifyInputs } from "./cosigners";
import {
  approveButton,
  approvedRun,
  declined,
  expectAnswerShape,
  holdRunAfter,
  releaseHold,
  requestOf,
  runMultisig,
  withReviewWindow,
  type MultisigEntry
} from "./helpers";
import { cosignerColumns, makeFullSizeRequest, makeWallet, publicKeyOf } from "./requests";

const PASSWORD = WALLET_A.password;
const COUNT = 20;
/** One request: at least this many characters, and at most the call's limit per request. */
const MIN_REQUEST = 900_000;
const MAX_REQUEST = 1_000_000;
/** Nineteen answers of at least `MIN_REQUEST` characters. */
const MIN_ANSWER = 17_000_000;
/** The time one step of a run of twenty full-size requests may take. */
const STEP = 120_000;

test.describe("multisig sign run at full size", () => {
  test.beforeEach(async ({ popup, context, dapp }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // Closing the window during a 17 MB run answers the page with the full list, the nineteen
  // finished results included, or rejects the call. It never leaves the page waiting or shortens
  // the list. Retrying keeps the finished responses and their bound challenges.
  test("a window closed with nineteen full-size results answers or rejects, and the same call again completes twenty", async ({
    context,
    dapp,
    popup
  }, testInfo) => {
    test.setTimeout(1_200_000);
    const signer = await publicKeyOf(WALLET_A, 0);
    const built = Array.from({ length: COUNT }, () => {
      const wallet = makeWallet(2, 3, signer);
      return { wallet, ...makeFullSizeRequest(wallet, RECIPIENT_ADDRESS) };
    });
    const items = built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr }));
    for (const { request } of items) {
      expect(request.length).toBeGreaterThanOrEqual(MIN_REQUEST);
      expect(request.length).toBeLessThanOrEqual(MAX_REQUEST);
    }

    // the wallet commits to all twenty, and the first co-signer of each commits after it
    const committed = await approvedRun(context, dapp, "commit", items, PASSWORD, STEP);
    const toSign = committed.map((entry, i) => {
      const [column] = cosignerColumns(built[i].wallet);
      return {
        id: items[i].id,
        request: cosignerCommit(requestOf(entry), built[i].wallet, column)
      };
    });
    for (const { request } of toSign) {
      expect(request.length).toBeGreaterThanOrEqual(MIN_REQUEST);
      expect(request.length).toBeLessThanOrEqual(MAX_REQUEST);
    }

    // nineteen rows done and the twentieth at work: its write waits behind the test's lock hold
    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "sign", toSign)
    );
    await expect(approveButton(win)).toBeVisible({ timeout: STEP });
    const hold = await holdRunAfter(win, popup.page, PASSWORD, COUNT - 1, STEP);
    await win.close({ runBeforeUnload: true });
    const closed = await result;

    // exactly two outcomes pass: the list with nineteen finished results, or the call's error
    let list: MultisigEntry[] | undefined;
    testInfo.annotations.push({
      type: "outcome",
      description: closed.ok ? "answered with a list" : "rejected with an error"
    });
    if (closed.ok) {
      list = closed.value;
      expect(list.length).toBe(COUNT);
      expect(list.map(({ id }) => id)).toEqual(items.map(({ id }) => id));
      for (const [i, entry] of list.slice(0, COUNT - 1).entries()) {
        expectAnswerShape(entry, toSign[i]);
        expect(requestOf(entry).length, `${entry.id} is full size`).toBeGreaterThanOrEqual(
          MIN_REQUEST
        );
      }
      expect(list[COUNT - 1]).toEqual(declined([items[COUNT - 1]])[0]);
      // a boolean: a failure never prints 17 MB of text
      expect(JSON.stringify(list).length > MIN_ANSWER, "the whole answer is above 17 MB").toBe(
        true
      );
    } else {
      expect(closed.error).toEqual({ message: expect.any(String) });
    }

    // the window is gone: the held write cannot reach storage once the hold goes
    await releaseHold(popup.page, hold);

    const again = await approvedRun(context, dapp, "sign", toSign, PASSWORD, STEP);
    expect(again.length).toBe(COUNT);
    for (const [i, entry] of again.entries()) {
      expectAnswerShape(entry, toSign[i]);
      expect(requestOf(entry).length, `${entry.id} is full size`).toBeGreaterThanOrEqual(
        MIN_REQUEST
      );
    }
    // the first nineteen are the answers the closed run gave: no second challenge, no new nonce
    if (list) {
      expect(
        list
          .slice(0, COUNT - 1)
          .every((entry, i) => JSON.stringify(entry) === JSON.stringify(again[i])),
        "the first nineteen answers equal the closed run's"
      ).toBe(true);
    }

    // the co-signers finish one of them, and sigma-rust judges it
    const [column] = cosignerColumns(built[0].wallet);
    const final = cosignerSign(requestOf(again[0]), built[0].wallet, column);
    expect(verifyInputs(final, built[0].wallet)).toEqual([true]);
  });
});
