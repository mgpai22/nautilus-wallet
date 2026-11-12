import type { NonceRecord } from "@ergo-msig/core";
import { hex } from "@fleet-sdk/crypto";
import { NetworkPrefix, SecretKey } from "ergo-lib-wasm-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HdKey from "@/chains/ergo/hdKey";
import { getPrivateDeriver } from "@/chains/ergo/transaction/prover";
import { openNonceStore } from "@/extension/connector/multisig/nonceStore";
import { childKeys } from "@/extension/connector/multisig/signerKeys";
import { addressOf, WALLET_A } from "../../e2e/fixtures/wallets";
import {
  expectedChange,
  expectedKey,
  madePassphrase,
  OLD_RECORD_A
} from "../../e2e/multisig/passphrase";

// storage.local in memory, as the nonce store's spec and tests/unit/walletsDbService.spec.ts fake
// it. The Dexie context is replaced as that spec replaces it: the wallets service imports it.
const { local, sets } = vi.hoisted(() => ({
  local: new Map<string, unknown>(),
  sets: [] as string[][]
}));

vi.mock("webextension-polyfill", () => ({
  storage: {
    local: {
      async get(keys: string | string[] | null) {
        const list = keys === null ? [...local.keys()] : ([] as string[]).concat(keys);
        return Object.fromEntries(
          list.filter((k) => local.has(k)).map((k) => [k, structuredClone(local.get(k))])
        );
      },
      async set(items: Record<string, unknown>) {
        sets.push(Object.keys(items));
        for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
      }
    }
  }
}));

vi.mock("@/database/dbContext", () => {
  const table = () => ({ where: () => ({ delete: async () => 0 }) });
  return {
    dbContext: {
      wallets: { toArray: async () => [], delete: async () => undefined },
      addresses: table(),
      assets: table(),
      connectedDApps: table(),
      utxos: table(),
      walletSync: { delete: async () => undefined }
    }
  };
});

const MNEMONIC = WALLET_A.mnemonic;

/** The address of a secret key, as sigma-rust reads it. */
const addressOfSecret = (secretKey: Uint8Array) =>
  SecretKey.dlog_from_bytes(secretKey).get_address().to_base58(NetworkPrefix.Mainnet);

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

function newRecord(txId: string): NonceRecord {
  return {
    txId,
    input: 0,
    column: 0,
    publicKey: random(33),
    nonce: random(32),
    commitment: random(33),
    challenge: undefined,
    simulated: []
  };
}

beforeEach(() => {
  local.clear();
  sets.length = 0;
});

/** Whether two records hold one nonce. A boolean, so that a failure never prints the nonce. */
const sameNonce = (a: NonceRecord, b: NonceRecord) => hex.encode(a.nonce) === hex.encode(b.nonce);

describe("a wallet's keys follow its passphrase", () => {
  // The passphrase reaches the seed unchanged, so the wallet restores the same keys as Minotaur,
  // and an empty passphrase leaves today's keys as they are.
  it("derives the node and the first addresses of the BIP39 seed that sigma-rust makes", async () => {
    const passphrase = madePassphrase();
    const key = await HdKey.fromMnemonic(MNEMONIC, passphrase);
    const expected = expectedChange(MNEMONIC, passphrase);

    expect(key.deriveAddress(0).script).toBe(expectedKey(MNEMONIC, passphrase, 0).address);
    expect(key.deriveAddress(1).script).toBe(expectedKey(MNEMONIC, passphrase, 1).address);
    expect(hex.encode(key.publicKey)).toBe(hex.encode(expected.publicKey));
    expect(hex.encode(key.chainCode)).toBe(hex.encode(expected.chainCode));
    // the passphrase moves the keys, so a wallet that has one is not the wallet of its mnemonic alone
    expect(key.deriveAddress(0).script).not.toBe(expectedKey(MNEMONIC, "", 0).address);

    // an empty passphrase gives today's address, as upstream's fixtures derive it
    const plain = await HdKey.fromMnemonic(MNEMONIC, "");
    expect(plain.deriveAddress(0).script).toBe(expectedKey(MNEMONIC, "", 0).address);
    expect(expectedKey(MNEMONIC, "", 0).address).toBe(await addressOf(WALLET_A, 0));
  });

  // A secret stored before passphrases existed reads as the mnemonic alone, with no part taken for
  // a passphrase, and the new form is not required. Old records are not rewritten.
  it("opens a record from before passphrase support with today's keys and does not write it again", async () => {
    const node = expectedChange(MNEMONIC, "");
    local.set("wallet:1", {
      id: 1,
      name: WALLET_A.name,
      type: "standard",
      publicKey: hex.encode(node.publicKey),
      chainCode: hex.encode(node.chainCode)
    });
    local.set("walletSecret:1", structuredClone(OLD_RECORD_A));

    const deriver = await getPrivateDeriver(1, WALLET_A.password);

    for (const index of [0, 1]) {
      expect(deriver.deriveAddress(index).script).toBe(await addressOf(WALLET_A, index));
    }
    expect(addressOfSecret(deriver.derivePrivateKey(0))).toBe(await addressOf(WALLET_A, 0));
    expect(local.get("walletSecret:1")).toEqual(OLD_RECORD_A);
    expect(sets).toEqual([]);
  });

  // Signer keys and their secret halves follow the passphrase: keys of the mnemonic alone find no
  // seat for a wallet that has one, and the core refuses every item under P4.
  it("changes the signer keys and the secret keys with the passphrase", async () => {
    const passphrases = [madePassphrase(), madePassphrase(), ""];
    const firstKeys: string[] = [];

    for (const passphrase of passphrases) {
      const key = await HdKey.fromMnemonic(MNEMONIC, passphrase);
      const keys = childKeys(
        { publicKey: hex.encode(key.publicKey), chainCode: hex.encode(key.chainCode) },
        1
      );

      for (const index of [0, 1]) {
        const expected = expectedKey(MNEMONIC, passphrase, index);
        expect(hex.encode(keys[index].publicKey)).toBe(hex.encode(expected.publicKey));
        expect(addressOfSecret(key.derivePrivateKey(index))).toBe(expected.address);
      }
      firstKeys.push(hex.encode(keys[0].publicKey));
    }

    expect(new Set(firstKeys).size).toBe(passphrases.length);
  });

  // The encryption key follows the passphrase, so two wallets of one mnemonic cannot open each
  // other's nonces, and it does not move for a wallet with no passphrase, so its records still open.
  it("encrypts nonce records under a key that follows the passphrase", async () => {
    const [a, b] = await Promise.all(
      [madePassphrase(), madePassphrase()].map((p) => HdKey.fromMnemonic(MNEMONIC, p))
    );
    const txId = hex.encode(random(32));
    // the store writes for a wallet that is stored: a and the wallet with no passphrase
    const walletOf = (key: HdKey) => ({ publicKey: hex.encode(key.publicKey) });
    local.set("wallet:1", walletOf(a));
    local.set("wallet:2", walletOf(await HdKey.fromMnemonic(MNEMONIC)));
    const record = newRecord(txId);
    await (await openNonceStore(a)).put([record]);
    const stored = structuredClone([...local]);

    // a's storage key and b's secret: only the secret differs
    const wrongSecret = await openNonceStore({ publicKey: a.publicKey, privateKey: b.privateKey });
    // a boolean, never the value: a failure must not print a nonce
    const wrongSecretRejects = await wrongSecret.get(txId, 0).then(
      () => false,
      (error: unknown) => error instanceof Error
    );
    expect(wrongSecretRejects, "the get with another passphrase's secret rejects").toBe(true);
    expect([...local]).toEqual(stored);

    const read = await (await openNonceStore(a)).get(txId, 0);
    expect(read && sameNonce(read, record), "the store of a reads its record back").toBe(true);

    // a wallet with no passphrase opens the records it had
    const [plain, empty] = await Promise.all([
      HdKey.fromMnemonic(MNEMONIC),
      HdKey.fromMnemonic(MNEMONIC, "")
    ]);
    const plainRecord = newRecord(hex.encode(random(32)));
    await (await openNonceStore(plain)).put([plainRecord]);
    const emptyRead = await (await openNonceStore(empty)).get(plainRecord.txId, 0);
    expect(emptyRead && sameNonce(emptyRead, plainRecord), "an empty passphrase reads it").toBe(
      true
    );
  });
});
