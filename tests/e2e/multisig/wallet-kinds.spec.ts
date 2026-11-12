import type { BrowserContext } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { WALLET_A, xpubOf } from "../fixtures/wallets";
import { connectDapp } from "../pages/connector";
import { expectNoWindow, makeItems, METHODS, runMultisig } from "./helpers";

const WATCHER = "Watcher";

/**
 * What a run of a wallet that cannot sign answers: one entry per item, in order, with exactly the
 * fields of a run's answer, the code `unsupported` and one plain sentence.
 */
const unsupported = (items: { id: string }[]) =>
  items.map(({ id }) => ({
    id,
    ok: false,
    code: "unsupported",
    message: expect.stringMatching(/^[A-Z][^\n]*\.$/)
  }));

/** Changes only the `type` of the public record of the wallet named `name`, in the service worker. */
async function setWalletType(context: BrowserContext, name: string, type: string) {
  const [worker] = context.serviceWorkers();
  const changed = await worker.evaluate(
    async ({ name, type }) => {
      const changed: string[] = [];
      for (const [key, value] of Object.entries(await chrome.storage.local.get())) {
        const isRecord = key.startsWith("wallet:") && typeof value === "object" && value !== null;
        if (!isRecord || !("name" in value) || value.name !== name) continue;
        await chrome.storage.local.set({ [key]: { ...value, type } });
        changed.push(key);
      }
      return changed;
    },
    { name, type }
  );
  expect(changed, `public records of ${name}`).toHaveLength(1);
}

test.describe("multisig run of a wallet that cannot sign", () => {
  test.beforeEach(async ({ popup }) => {
    await popup.importReadOnlyWallet(WATCHER, await xpubOf(WALLET_A));
  });

  // A wallet that cannot sign gets its answer without a review window, never a window with a dead
  // control as upstream's sign_tx opens for a read-only wallet.
  test("a read-only wallet answers every item as unsupported, with no window", async ({
    context,
    dapp
  }) => {
    await connectDapp(context, dapp, WATCHER);

    for (const method of METHODS) {
      const items = makeItems(2, `readonly-${method}`);
      const outcome = await expectNoWindow(context, dapp, () => runMultisig(dapp, method, items));
      expect(outcome, method).toEqual({ ok: true, value: unsupported(items) });
    }
  });

  // Ledger wallets are refused before the review window too: a check written as
  // type === "readonly" would let them through.
  test("a Ledger wallet answers every item as unsupported, with no window", async ({
    context,
    dapp
  }) => {
    await setWalletType(context, WATCHER, "ledger");
    await connectDapp(context, dapp, WATCHER);

    for (const method of METHODS) {
      const items = makeItems(2, `ledger-${method}`);
      const outcome = await expectNoWindow(context, dapp, () => runMultisig(dapp, method, items));
      expect(outcome, method).toEqual({ ok: true, value: unsupported(items) });
    }
  });
});
