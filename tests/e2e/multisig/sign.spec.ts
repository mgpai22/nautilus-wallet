import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { connectDapp } from "../pages/connector";
import { cosignerCommit, cosignerSign, verifyInputs } from "./cosigners";
import {
  approvedRun,
  expectAnswerShape,
  nonceTxIds,
  removeNonceRecord,
  requestOf
} from "./helpers";
import { expectedKey, madePassphrase, restoreWithPassphrase } from "./passphrase";
import { cellsOf, cosignerColumns, makeRequest, makeWallet, publicKeyOf } from "./requests";

const PASSWORD = WALLET_A.password;

/** The sizes of a signer's cell: a commitment, a response, and a response over simulated ones. */
const RESPONSE_BYTES = 89;
const SIMULATED_BYTES = 90;

test.describe("multisig sign run, judged by sigma-rust", () => {
  // Real co-signers can build on the wallet's response: sigma-rust accepts its simulated proofs and
  // its challenge, and the signer key and secret key follow the passphrase, so a wallet that has
  // one finds its seat and signs with the right key.
  test("a 2 of 3 wallet restored with a passphrase signs first and sigma-rust verifies every input", async ({
    popup,
    context,
    dapp
  }) => {
    test.setTimeout(120_000);
    const passphrase = madePassphrase();
    await restoreWithPassphrase(popup, WALLET_A, passphrase);
    await connectDapp(context, dapp, WALLET_A.name);

    // the wallet's key in the script is the one sigma-rust derives from the mnemonic and the passphrase
    const wallet = makeWallet(2, 3, expectedKey(WALLET_A.mnemonic, passphrase, 0).publicKey);
    const [column] = cosignerColumns(wallet);
    const built = makeRequest(wallet, 2);
    const item = { id: "payroll-1", request: built.csr };

    const [committed] = await approvedRun(context, dapp, "commit", [item], PASSWORD);
    expectAnswerShape(committed, item);
    // the co-signer commits on the wallet's request: two commitments, the third key is not asked
    const toSign = {
      id: item.id,
      request: cosignerCommit(requestOf(committed), wallet, column)
    };

    const [signed] = await approvedRun(context, dapp, "sign", [toSign], PASSWORD);
    expectAnswerShape(signed, toSign);

    // the wallet signed first: its own cell holds a response and the silent third key's is simulated
    const mine = cellsOf(requestOf(signed)).map((row) => row.map((cell) => cell.length));
    expect(mine.map((row) => [...row].sort((a, b) => a - b))).toEqual(
      mine.map(() => [33, RESPONSE_BYTES, SIMULATED_BYTES])
    );
    // one response is not a transaction, and the record that a retry needs stays
    expect(verifyInputs(requestOf(signed), wallet)).toEqual([false, false]);
    expect(await nonceTxIds(context)).toEqual([built.txId]);

    const final = cosignerSign(requestOf(signed), wallet, column);
    expect(verifyInputs(final, wallet)).toEqual([true, true]);
  });

  test.describe("with the wallet's own mnemonic", () => {
    test.beforeEach(async ({ popup, context, dapp }) => {
      await popup.importWallet(WALLET_A);
      await connectDapp(context, dapp, WALLET_A.name);
    });

    // The last proof of a 6 of 10 verifies when the wallet signs last. The records of the complete
    // transaction go, and the record of a transaction that stays open stays.
    test("a 6 of 10 wallet signs last, every input verifies and only the open transaction keeps its record", async ({
      context,
      dapp
    }) => {
      test.setTimeout(120_000);
      const signer = await publicKeyOf(WALLET_A, 0);
      const wallet = makeWallet(6, 10, signer);
      const columns = cosignerColumns(wallet);
      const built = makeRequest(wallet, 2);
      // a second transaction of another wallet: it stays open, so its record must stay
      const open = makeRequest(makeWallet(2, 3, signer), 1);

      // two co-signers commit, then the wallet, then three more: six commitments in all
      let text = built.csr;
      for (const column of columns.slice(0, 2)) text = cosignerCommit(text, wallet, column);
      const items = [
        { id: "treasury", request: text },
        { id: "open", request: open.csr }
      ];

      const committed = await approvedRun(context, dapp, "commit", items, PASSWORD);
      committed.forEach((entry, i) => expectAnswerShape(entry, items[i]));
      expect(await nonceTxIds(context)).toEqual([built.txId, open.txId].sort());

      text = requestOf(committed[0]);
      for (const column of columns.slice(2, 5)) text = cosignerCommit(text, wallet, column);
      // the five co-signers sign in turn: the first signs over simulated proofs for the four silent keys
      for (const column of columns.slice(0, 5)) text = cosignerSign(text, wallet, column);
      expect(verifyInputs(text, wallet)).toEqual([false, false]);

      const toSign = { id: "treasury", request: text };
      const [signed] = await approvedRun(context, dapp, "sign", [toSign], PASSWORD);
      expectAnswerShape(signed, toSign);

      expect(verifyInputs(requestOf(signed), wallet)).toEqual([true, true]);
      // the wallet signed last: the core says the transaction is complete and its record goes
      expect(await nonceTxIds(context)).toEqual([open.txId]);
    });

    // One item whose record is gone fails alone, with the code of the core's refusal, and the other
    // items are still signed.
    test("an item whose record is gone is refused and the other two are signed", async ({
      context,
      dapp
    }) => {
      test.setTimeout(120_000);
      const signer = await publicKeyOf(WALLET_A, 0);
      const built = Array.from({ length: 3 }, () => {
        const wallet = makeWallet(2, 3, signer);
        return { wallet, ...makeRequest(wallet, 1) };
      });
      const items = built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr }));

      const committed = await approvedRun(context, dapp, "commit", items, PASSWORD);
      const toSign = committed.map((entry, i) => {
        const [column] = cosignerColumns(built[i].wallet);
        return {
          id: items[i].id,
          request: cosignerCommit(requestOf(entry), built[i].wallet, column)
        };
      });
      // the wallet lost the record of the middle one: the request is still due for a signature
      await removeNonceRecord(context, built[1].txId);

      const answers = await approvedRun(context, dapp, "sign", toSign, PASSWORD);
      expect(answers).toHaveLength(3);
      for (const i of [0, 2]) {
        expectAnswerShape(answers[i], toSign[i]);
        const [column] = cosignerColumns(built[i].wallet);
        const final = cosignerSign(requestOf(answers[i]), built[i].wallet, column);
        expect(verifyInputs(final, built[i].wallet), `${toSign[i].id} verifies`).toEqual([true]);
      }

      const [, refused] = answers;
      expect(Object.keys(refused).sort()).toEqual(["code", "id", "message", "ok"]);
      expect(refused).toMatchObject({ id: "payroll-2", ok: false, code: "refused" });
      // the core's rule P6 (no stored nonce for the input) and its sentence, as the core gives it
      if (refused.ok) throw new Error("payroll-2 was signed with no record");
      expect(refused.message).toMatch(/^P6: /);
      // the two signed items keep their records: they are not complete
      expect(await nonceTxIds(context)).toEqual([built[0].txId, built[2].txId].sort());
    });
  });
});
