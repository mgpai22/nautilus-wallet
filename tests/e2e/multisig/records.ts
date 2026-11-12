/**
 * The contract of the stored records screen that the tests fix, and the helpers its specs share.
 * The texts are English: the popup runs in `en-US`. Nothing here reads a record's contents: a
 * test sees storage key names and booleans only.
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { TestWallet } from "../fixtures/wallets";
import type { Popup } from "../pages/popup";
import { approvedRun, type MultisigEntry } from "./helpers";
import { makeRequest, makeWallet, publicKeyOf, type MultisigWallet } from "./requests";

/** The Wallet tab of the settings holds one region of this name, for a standard wallet. */
export const REGION_NAME = "Multi-signature records";

/** What the region says when the wallet has no record. */
export const EMPTY_TEXT = "No records stored for this wallet.";

/** What the confirmation dialog tells the signer before a record goes. */
export const WARNING =
  /an open transaction whose record is removed can no longer be signed by this signer/i;

/** What the wallet's own removal drawer tells the signer of a standard wallet, records or not. */
export const REMOVAL_WARNING =
  /deletes its multi-signature records\. A transaction it committed to can then no longer be signed by this wallet, even if you restore it/i;

export const recordsRegion = (page: Page) => page.getByRole("region", { name: REGION_NAME });

/** The row of one transaction: a list item of the region that shows the transaction's id. */
export const recordRow = (page: Page, txId: string) =>
  recordsRegion(page).getByRole("listitem").filter({ hasText: txId });

/** "Remove" of a row: its name starts with the word, so the tab stops of a screen can be counted. */
export const rowRemove = (row: Locator) => row.getByRole("button", { name: /^Remove/ });

/** Opens the Wallet tab of the settings of the wallet that is loaded. */
export async function openWalletSettings(popup: Popup) {
  await popup.goto("/settings");
  await popup.page.getByRole("tab", { name: "Wallet" }).click();
}

export type Committed = {
  txIds: string[];
  wallets: MultisigWallet[];
  /** The page's answers to the commit run, in order. */
  answers: MultisigEntry[];
};

/**
 * One commit run through the window for `wallet` as the signer: one transaction per entry of
 * `inputCounts`, each of its own 2 of 3 wallet and with that many inputs. The records of the
 * run are stored when this returns. `page` is a page of the origin the wallet is connected to.
 */
export async function commitRecords(
  context: BrowserContext,
  page: Page,
  wallet: TestWallet,
  inputCounts: number[]
): Promise<Committed> {
  const signer = await publicKeyOf(wallet, 0);
  const wallets = inputCounts.map(() => makeWallet(2, 3, signer));
  const built = wallets.map((w, i) => makeRequest(w, inputCounts[i]));
  const items = built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr }));

  const answers = await approvedRun(context, page, "commit", items, wallet.password);
  return { txIds: built.map(({ txId }) => txId), wallets, answers };
}

/** The storage keys of the wallets, as the service worker reads storage. Never a value. */
export async function walletKeys(context: BrowserContext): Promise<string[]> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const keys = await worker.evaluate(async () => Object.keys(await chrome.storage.local.get()));
  return keys.filter((key) => /^wallet:\d+$/.test(key));
}
