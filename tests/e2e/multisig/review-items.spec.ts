import { expect, test } from "../fixtures/test";
import { RECIPIENT_ADDRESS, TEST_TOKEN, WALLET_A, WALLET_B } from "../fixtures/wallets";
import { clickToClose, connectDapp } from "../pages/connector";
import {
  DECLINE,
  declined,
  decimalText,
  reviewRows,
  runMultisig,
  withReviewWindow,
  type MultisigEntry
} from "./helpers";
import {
  columnOf,
  FEE_ADDRESS,
  makeRequest,
  makeWallet,
  publicKeyOf,
  withCommitments
} from "./requests";

const ERG_DECIMALS = 9;
/** The mark on an output that returns to the multi-sig address the inputs come from. */
const RETURNS = /returns to the multi-signature address/i;

type Refused = Extract<MultisigEntry, { ok: false }>;

test.describe("multisig review of every item", () => {
  test.beforeEach(async ({ popup, context, dapp, chain }) => {
    chain.addToken(TEST_TOKEN);
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // The review shows what the core read, in full: token ids uncut (upstream's card cuts them to 7
  // characters), the right M of N, each output's address, value and tokens, the fee apart from the
  // payments, tokens sent to the fee script, the mark only on the output that returns to the
  // multi-sig address, and none of the page's words as fact.
  test("a 2 of 3 item shows its id, M of N, every output, the fee and the return mark", async ({
    context,
    dapp
  }) => {
    const wallet = makeWallet(2, 3, await publicKeyOf(WALLET_A, 0));
    const built = makeRequest(wallet, 1, {
      address: RECIPIENT_ADDRESS,
      value: 123_456_789n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 12_345n }]
    });
    const [payment, change] = built.outputs;
    // a second item pays tokens to the fee script: the core calls the output a fee by its
    // script alone, and its tokens must still show
    const toFee = makeRequest(wallet, 1, {
      address: FEE_ADDRESS,
      value: 100_000_000n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 6_789n }]
    });
    const items = [
      { id: "payroll-1", request: built.csr },
      { id: "payroll-2", request: toFee.csr }
    ];

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    const row = reviewRows(win).first();

    // sigma-rust's id of the transaction, in full
    await expect(row).toContainText(built.txId);
    await expect(row).toContainText("2 of 3");
    for (const output of built.outputs) {
      await expect(row).toContainText(output.address);
      await expect(row).toContainText(decimalText(output.value, ERG_DECIMALS));
    }
    // the token's name and its id in full, with the amount scaled by the token's decimals
    await expect(row).toContainText(TEST_TOKEN.name);
    await expect(row).toContainText(TEST_TOKEN.tokenId);
    await expect(row).toContainText(decimalText(12_345n, TEST_TOKEN.decimals));
    await expect(row).toContainText(/fee/i);
    await expect(row).toContainText(decimalText(built.fee, ERG_DECIMALS));
    await expect(row).not.toContainText(FEE_ADDRESS);

    // the mark is on the output that returns to the multi-sig address, and on that one only
    await expect(row.getByText(RETURNS)).toHaveCount(1);
    const around = (address: string, other: string) =>
      row
        .locator("*")
        .filter({ hasText: address })
        .filter({ hasNotText: other })
        .filter({ hasText: RETURNS });
    await expect(around(change.address, payment.address)).not.toHaveCount(0);
    await expect(around(payment.address, change.address)).toHaveCount(0);

    const feeRow = reviewRows(win).nth(1);
    await expect(feeRow).toContainText(toFee.txId);
    await expect(feeRow).toContainText(FEE_ADDRESS);
    await expect(feeRow).toContainText(decimalText(100_000_000n, ERG_DECIMALS));
    await expect(feeRow).toContainText(TEST_TOKEN.tokenId);
    await expect(feeRow).toContainText(decimalText(6_789n, TEST_TOKEN.decimals));

    // the id and the request text are the page's words
    await expect(win.locator("body")).not.toContainText("payroll-1");

    await clickToClose(win.getByRole("button", { name: DECLINE }));
    expect(await result).toEqual({ ok: true, value: declined(items) });
  });

  // One text that is no request stops its own item only, and a refusal of the core is not answered
  // as declined.
  test("an item that is no request is listed with the core's reason and keeps its code when the run is declined", async ({
    context,
    dapp
  }) => {
    const wallet = makeWallet(2, 3, await publicKeyOf(WALLET_A, 0));
    const good = makeRequest(wallet, 1);
    const items = [
      { id: "payroll-1", request: good.csr },
      { id: "payroll-2", request: "this is not a request" }
    ];

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    const rows = reviewRows(win);

    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(good.txId);
    await expect(rows.nth(1)).toContainText(/C5: /);
    const shown = await rows.nth(1).innerText();

    await clickToClose(win.getByRole("button", { name: DECLINE }));

    // a request the core cannot read (its rule C5) answers unsupported
    const answer = await result;
    expect(answer).toEqual({
      ok: true,
      value: [
        declined(items)[0],
        {
          id: "payroll-2",
          ok: false,
          code: "unsupported",
          message: expect.stringMatching(/^C5: /)
        }
      ]
    });
    // the row shows the reason as the answer gives it
    if (!answer.ok) throw new Error("The call was rejected.");
    expect(shown).toContain((answer.value[1] as Refused).message);
  });

  // An item no key of this wallet can take part in is refused, with no password asked and no
  // answer of declined. Nothing falls back to another key, as upstream's signing falls back to the
  // change address and to index 0.
  test("a request this wallet is no signer of is refused and the window never asks for a password", async ({
    context,
    dapp
  }) => {
    // the signer's key is Bob's, upstream's second test wallet, and the connected wallet is Alice
    const stranger = makeWallet(2, 3, await publicKeyOf(WALLET_B, 0));
    const items = [{ id: "payroll-1", request: makeRequest(stranger, 1).csr }];

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    const row = reviewRows(win).first();

    await expect(row).toContainText(/P4: /);
    await expect(win.locator("input")).toHaveCount(0);
    const shown = await row.innerText();

    await clickToClose(win.getByRole("button", { name: DECLINE }));

    const answer = await result;
    expect(answer).toEqual({
      ok: true,
      value: [
        { id: "payroll-1", ok: false, code: "refused", message: expect.stringMatching(/^P4: /) }
      ]
    });
    if (!answer.ok) throw new Error("The call was rejected.");
    expect(shown).toContain((answer.value[0] as Refused).message);
  });

  // Answering every refusal of the core as refused would hide from the page whether a wallet shape
  // never works or a step is only not due yet.
  test("a 1 of 3 wallet answers unsupported and a step already done answers refused", async ({
    context,
    dapp
  }) => {
    const signer = await publicKeyOf(WALLET_A, 0);
    const oneOfThree = makeWallet(1, 3, signer);
    const twoOfThree = makeWallet(2, 3, signer);
    const committed = withCommitments(makeRequest(twoOfThree, 1).csr, twoOfThree, [
      columnOf(twoOfThree, signer)
    ]);
    const items = [
      { id: "payroll-1", request: makeRequest(oneOfThree, 1).csr },
      { id: "payroll-2", request: committed }
    ];

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    const rows = reviewRows(win);

    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(/P2: /);
    // this wallet's step is not due: the window gives its own reason once it has read the item
    await expect(rows.nth(1)).not.toContainText(/not read/i);
    const shown = await rows.nth(1).innerText();

    await clickToClose(win.getByRole("button", { name: DECLINE }));

    const answer = await result;
    expect(answer).toEqual({
      ok: true,
      value: [
        {
          id: "payroll-1",
          ok: false,
          code: "unsupported",
          message: expect.stringMatching(/^P2: /)
        },
        { id: "payroll-2", ok: false, code: "refused", message: expect.stringMatching(/\S/) }
      ]
    });
    if (!answer.ok) throw new Error("The call was rejected.");
    expect(shown).toContain((answer.value[1] as Refused).message);
  });
});
