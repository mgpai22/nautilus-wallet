import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { connectDapp, invoke } from "../pages/connector";

test.describe("multisig on the dApp context", () => {
  // Fails if multisig sits on the prototype, where a page script can shadow it, or if multisig is
  // left unfrozen, so a page can swap commit.
  test("is the context's one own property, frozen, with version 1, commit and sign", async ({
    popup,
    context,
    dapp
  }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);

    expect(
      await invoke(dapp, async () => {
        const ctx = await window.ergoConnector.nautilus.getContext();
        return { own: Object.hasOwn(ctx, "multisig"), contextKeys: Reflect.ownKeys(ctx) };
      })
    ).toEqual({ ok: true, value: { own: true, contextKeys: ["multisig"] } });

    expect(
      await invoke(dapp, async () => {
        const { multisig } = await window.ergoConnector.nautilus.getContext();
        const commit = multisig.commit;
        try {
          multisig.commit = () => Promise.resolve("forged");
        } catch {
          // a frozen object throws in strict code
        }

        return {
          frozen: Object.isFrozen(multisig),
          keys: Reflect.ownKeys(multisig).sort(),
          version: multisig.version,
          types: [typeof multisig.commit, typeof multisig.sign],
          commitKept: multisig.commit === commit
        };
      })
    ).toEqual({
      ok: true,
      value: {
        frozen: true,
        keys: ["commit", "sign", "version"],
        version: 1,
        types: ["function", "function"],
        commitKept: true
      }
    });
  });
});
