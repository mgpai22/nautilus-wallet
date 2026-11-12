import { hex } from "@fleet-sdk/crypto";
import { ErgoHDKey } from "@fleet-sdk/wallet";
import { beforeAll, describe, expect, it } from "vitest";
import { setupI18n } from "@/i18n";
import messages from "@/i18n/locales/en-US.json";
import { addressOf, TEST_TOKEN, WALLET_A } from "../../../../tests/e2e/fixtures/wallets";
import {
  columnOf,
  FEE_ADDRESS,
  makeRequest,
  makeWallet,
  publicKeyOf,
  withCommitments
} from "../../../../tests/e2e/multisig/requests";
import { readItem, type Reading } from "./review";
import { childKeys } from "./signerKeys";

/** The review of an item that the core read, or the failure the test reports. */
function reviewOf(result: Reading) {
  if (!result.ok) throw new Error(`The item was refused: ${result.code}, ${result.message}`);
  return result.review;
}

// Test wallet: the keys upstream's end-to-end fixtures use. Requests and expected values come
// from the request builder (sigma-rust), never from the core.
describe("the review of one item", () => {
  // the window sets the global translator up before any view loads
  beforeAll(() => {
    setupI18n();
  });

  // The marked output is found from the multi-sig script, not from the Nautilus wallet's own
  // addresses. The fee is not read as a payment, tokens sent to the fee script are not hidden in the
  // fee, and every id, value, token id and raw amount is what the builder put in.
  it("reads the id, M of N, every output and the fee, and marks the output back to the multi-sig address", async () => {
    const signer = await publicKeyOf(WALLET_A, 0);
    const wallet = makeWallet(2, 3, signer);
    // the payment goes to the signer's own address in the Nautilus wallet: it is not the
    // multi-sig address, so it must not be marked
    const built = makeRequest(wallet, 2, {
      address: await addressOf(WALLET_A, 0),
      value: 250_000_000n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 12_345n }]
    });

    const review = reviewOf(readItem(built.csr, [{ publicKey: signer }], "commit"));

    expect(review.txId).toBe(built.txId);
    expect(review.inputs).toEqual([
      { k: 2, n: 3 },
      { k: 2, n: 3 }
    ]);
    // payment, then the rest back to the wallet: the fee is not an output of the review
    expect(review.outputs).toMatchObject(built.outputs);
    expect(review.fee).toBe(built.fee);

    // an output to the fee script is the core's fee by its script alone, and it can carry
    // tokens: they must show as an output of their own, and every nanoERG sent there is fee
    const toFee = makeRequest(wallet, 1, {
      address: FEE_ADDRESS,
      value: 100_000_000n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 6_789n }]
    });
    const feeReview = reviewOf(readItem(toFee.csr, [{ publicKey: signer }], "commit"));

    expect(feeReview.outputs).toMatchObject(toFee.outputs);
    expect(feeReview.outputs[0]).toMatchObject({
      address: FEE_ADDRESS,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 6_789n }]
    });
    expect(feeReview.fee).toBe(toFee.fee + 100_000_000n);
  });

  // The key range reaches past the stored addresses, so a signer whose key never held funds can
  // still sign, and the range has an end.
  it("finds the signer's key up to 20 indexes past the highest stored one and not further", async () => {
    const change = await ErgoHDKey.fromMnemonic(WALLET_A.mnemonic);
    const highest = 3;
    const keys = childKeys(
      {
        publicKey: hex.encode(change.publicKey),
        chainCode: hex.encode(change.chainCode as Uint8Array)
      },
      highest
    );

    const atLimit = makeRequest(makeWallet(2, 3, change.deriveChild(highest + 20).publicKey), 1);
    expect(readItem(atLimit.csr, keys, "commit")).toMatchObject({ ok: true });

    const past = makeRequest(makeWallet(2, 3, change.deriveChild(highest + 21).publicKey), 1);
    expect(readItem(past.csr, keys, "commit")).toMatchObject({
      ok: false,
      code: "refused",
      message: expect.stringMatching(/^P4: /)
    });
  });

  // An item due for the other step is not approvable, and the wallet's own sentence for it carries
  // no rule id, so it cannot pass for a refusal of the core.
  it("refuses an item whose step is not the step of the run", async () => {
    const signer = await publicKeyOf(WALLET_A, 0);
    const keys = [{ publicKey: signer }];
    const wallet = makeWallet(2, 3, signer);
    const own = columnOf(wallet, signer);
    const { csr } = makeRequest(wallet, 1);
    // this signer and one co-signer committed: k of 2 is reached and this signer's step is the signature
    const committed = withCommitments(csr, wallet, [own, (own + 1) % 3]);
    // stepDue only says which step is due: the core refuses nothing here, so the sentence is
    // this wallet's own, from its catalog, and has no rule id in front
    const notDue = (sentence: string) => ({ ok: false, code: "refused", message: sentence });

    expect(readItem(csr, keys, "commit")).toMatchObject({ ok: true });
    expect(readItem(committed, keys, "commit")).toEqual(
      notDue(messages.connector.multisig.notDueCommit)
    );

    expect(readItem(committed, keys, "sign")).toMatchObject({ ok: true });
    expect(readItem(csr, keys, "sign")).toEqual(notDue(messages.connector.multisig.notDueSign));
  });
});
