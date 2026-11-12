import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import type { Popup } from "../pages/popup";
import { WALLET_A, WALLET_B } from "../fixtures/wallets";
import { connectDapp } from "../pages/connector";
import { cosignerColumns } from "./requests";
import { cosignerCommit, cosignerSign, verifyInputs } from "./cosigners";
import {
  approvedRun,
  approveButton,
  expectAnswerShape,
  holdGranted,
  makeItems,
  nonceTxIds,
  openChannelPage,
  passwordField,
  queueHold,
  releaseHold,
  requestOf,
  runMultisig,
  waitingForLock,
  withReviewWindow
} from "./helpers";
import {
  commitRecords,
  openWalletSettings,
  recordRow,
  recordsRegion,
  REMOVAL_WARNING,
  rowRemove,
  WARNING,
  walletKeys
} from "./records";

const BOB_ORIGIN = "https://bob-dapp.test";

/** Waits for the storage of the nonce records to hold exactly the records of `txIds`. */
const expectRecordsOf = (context: BrowserContext, txIds: string[]) =>
  expect
    .poll(() => nonceTxIds(context), { message: "the transactions that have a record" })
    .toEqual([...txIds].sort());

test.describe("stored multisig records in the wallet's settings", () => {
  // Fails on a record nobody can remove, a removal that only hides the row, a removal with no
  // question first, or a sign run that still finds a removed record.
  test("lists a committed transaction, removes its record after the warning, and a sign run is refused", async ({
    popup,
    context,
    dapp
  }) => {
    test.setTimeout(180_000);
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);

    // two transactions: the first has two inputs, the second one. Only the first is removed.
    const { txIds, wallets, answers } = await commitRecords(context, dapp, WALLET_A, [2, 1]);
    const [removed, kept] = txIds;
    await expectRecordsOf(context, txIds);

    await openWalletSettings(popup);
    const page = popup.page;
    await expect(recordsRegion(page).getByRole("listitem")).toHaveCount(2);
    // each row names its transaction, the number of its inputs and the day its record was made
    await expect(recordRow(page, removed).getByText("2 inputs", { exact: true })).toBeVisible();
    await expect(recordRow(page, kept).getByText("1 input", { exact: true })).toBeVisible();
    await expect(recordRow(page, removed)).toContainText(String(new Date().getFullYear()));

    // the dialog gives the keyboard back to the row that opened it, however it closes
    const dialog = page.getByRole("dialog");
    const keptRemove = rowRemove(recordRow(page, kept));
    await keptRemove.click();
    await expect(dialog).toContainText(WARNING);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(keptRemove, "focus after Cancel").toBeFocused();
    await keptRemove.click();
    await expect(dialog).toContainText(WARNING);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(keptRemove, "focus after Escape").toBeFocused();

    // Remove asks first: the warning shows and nothing is removed until it is confirmed
    await rowRemove(recordRow(page, removed)).click();
    await expect(dialog).toContainText(WARNING);
    await expectRecordsOf(context, txIds);

    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden();
    // the row that held the keyboard is gone: it moves to the list, not to the page's top
    await expect(
      recordsRegion(page).locator(":focus"),
      "focus after a removal stays in the records"
    ).toHaveCount(1);
    await expect(recordRow(page, removed)).toHaveCount(0);
    await expect(recordRow(page, kept)).toHaveCount(1);
    // gone from storage too: the row is not merely hidden
    await expectRecordsOf(context, [kept]);

    // the signer is asked to sign both: the removed one has no nonce left, the other signs
    const toSign = answers.map((entry, i) => ({
      id: `payroll-${i + 1}`,
      request: cosignerCommit(requestOf(entry), wallets[i], cosignerColumns(wallets[i])[0])
    }));
    const signed = await approvedRun(context, dapp, "sign", toSign, WALLET_A.password);

    expect(signed[0]).toMatchObject({ id: "payroll-1", ok: false, code: "refused" });
    expect(signed[0].ok ? "" : signed[0].message).toMatch(/^P6: /);
    expectAnswerShape(signed[1], toSign[1]);
    const final = cosignerSign(requestOf(signed[1]), wallets[1], cosignerColumns(wallets[1])[0]);
    expect(verifyInputs(final, wallets[1])).toEqual([true]);
  });

  test.describe("with the records of two wallets", () => {
    /** Alice's and Bob's transactions, committed through the window of each wallet's own origin. */
    async function commitBoth(context: BrowserContext, popup: Popup, dapp: Page) {
      await popup.importWallet(WALLET_A);
      await popup.importWallet(WALLET_B);
      await connectDapp(context, dapp, WALLET_A.name);
      const bobPage = await openChannelPage(context, BOB_ORIGIN);
      await connectDapp(context, bobPage, WALLET_B.name);

      const alice = await commitRecords(context, dapp, WALLET_A, [1, 1]);
      const bob = await commitRecords(context, bobPage, WALLET_B, [1]);
      await expectRecordsOf(context, [...alice.txIds, ...bob.txIds]);
      return { alice: alice.txIds, bob: bob.txIds };
    }

    // Each wallet's settings list only its own records, never another wallet's transactions.
    test("each wallet's settings list its own records only", async ({ popup, context, dapp }) => {
      test.setTimeout(240_000);
      const { alice, bob } = await commitBoth(context, popup, dapp);
      const page = popup.page;

      // Bob was imported last, so his wallet is the one loaded
      await openWalletSettings(popup);
      await expect(recordsRegion(page).getByRole("listitem")).toHaveCount(bob.length);
      await expect(recordRow(page, bob[0])).toHaveCount(1);
      for (const txId of alice) await expect(recordRow(page, txId)).toHaveCount(0);

      await popup.switchWallet(WALLET_A.name);
      await openWalletSettings(popup);
      await expect(recordsRegion(page).getByRole("listitem")).toHaveCount(alice.length);
      for (const txId of alice) await expect(recordRow(page, txId)).toHaveCount(1);
      await expect(recordRow(page, bob[0])).toHaveCount(0);
    });

    // Removing a wallet removes its records from storage and leaves the other wallet's records.
    test("removing a wallet removes its records and keeps the other wallet's", async ({
      popup,
      context,
      dapp
    }) => {
      test.setTimeout(240_000);
      const { alice } = await commitBoth(context, popup, dapp);
      const page = popup.page;

      // Bob is the loaded wallet: remove it as upstream's settings do, by typing its name
      await openWalletSettings(popup);
      // the wallet's own button: the row buttons of the records are named "Remove record ..."
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      const drawer = page.getByRole("dialog");
      // the signer hears that the records go before the removal is confirmed
      await expect(drawer).toContainText(REMOVAL_WARNING);
      await drawer.getByLabel(`To confirm, type "${WALLET_B.name}" below.`).fill(WALLET_B.name);
      await drawer.getByRole("button", { name: "Remove" }).last().click();
      await popup.expectWalletLoaded(WALLET_A.name);

      await expectRecordsOf(context, alice);
    });

    // A run approved before the removal stores no record once the cleanup has scanned, and the
    // cleanup and the wallet's deletion run under one hold of the lock.
    test("a put that waits behind the wallet's removal stores nothing and its item fails", async ({
      popup,
      context,
      dapp
    }) => {
      test.setTimeout(240_000);
      const { bob } = await commitBoth(context, popup, dapp);
      await popup.switchWallet(WALLET_A.name);
      const page = popup.page;

      // a run waits for Approve: the window is open and the wallet's secret is still stored
      const { win, result } = await withReviewWindow(context, () =>
        runMultisig(dapp, "commit", makeItems(1, "late"))
      );
      await expect(approveButton(win)).toBeEnabled();
      const lockPage = await context.newPage();
      await lockPage.goto(popup.baseUrl);
      const hold = await queueHold(lockPage);
      await holdGranted(lockPage, hold);

      // the removal asks for the lock first, and waits behind the hold
      await openWalletSettings(popup);
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByLabel(`To confirm, type "${WALLET_A.name}" below.`).fill(WALLET_A.name);
      await drawer.getByRole("button", { name: "Remove" }).last().click();
      await expect.poll(() => waitingForLock(lockPage), { message: "the removal waits" }).toBe(1);

      // Approve unlocks the wallet and commits: the put queues behind the removal
      await passwordField(win).fill(WALLET_A.password);
      await approveButton(win).click();
      await expect
        .poll(() => waitingForLock(lockPage), { message: "the put waits", timeout: 60_000 })
        .toBe(2);
      await releaseHold(lockPage, hold);

      const outcome = await result;
      // the wallet is gone with its records, and only the other wallet's remain
      await popup.expectWalletLoaded(WALLET_B.name);
      expect(await walletKeys(context)).toHaveLength(1);
      await expectRecordsOf(context, bob);
      // the run goes on: the item is reported failed, with a sentence and no record in it
      expect(outcome.ok && outcome.value[0]).toMatchObject({
        id: "late-1",
        ok: false,
        code: "refused"
      });
    });
  });
});
