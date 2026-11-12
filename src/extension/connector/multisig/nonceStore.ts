import { Refusal, type Binding, type NonceRecord, type NonceStore } from "@ergo-msig/core";
import { hex } from "@fleet-sdk/crypto";
import { storage } from "webextension-polyfill";

/**
 * The nonce store of the connector window. The records of one transaction rest under one storage
 * key, in one AES-256-GCM text bound to that key. The key comes from the wallet's secret and lives
 * only in this window.
 */

/** A record in the encrypted text, its bytes as hex. The transaction is the storage key's. */
type StoredRecord = {
  input: number;
  column: number;
  publicKey: string;
  nonce: string;
  commitment: string;
  challenge: string | null;
  simulated: { column: number; commitment: string; challenge: string; response: string }[];
};

/** The value under a storage key. Everything but `data` is clear, for the list in the settings. */
type StoredValue = { v: 1; createdAt: number; inputs: number; iv: string; data: string };

const LOCK_NAME = "nautilus:msig-nonces";
const encoder = new TextEncoder();
const KEY_LABEL = encoder.encode("nautilus:msig-nonce-store:v1");

const bytes = (text: string) => new Uint8Array(hex.decode(text));

function bindingText({ challenge, simulated }: Pick<StoredRecord, "challenge" | "simulated">) {
  return JSON.stringify([challenge, simulated]);
}

function toStored(binding: Pick<NonceRecord, "challenge" | "simulated">) {
  return {
    challenge: binding.challenge ? hex.encode(binding.challenge) : null,
    simulated: binding.simulated.map((proof) => ({
      column: proof.column,
      commitment: hex.encode(proof.commitment),
      challenge: hex.encode(proof.challenge),
      response: hex.encode(proof.response)
    }))
  };
}

/**
 * The store over `wallet`'s records. `wallet` is the deriver `getPrivateDeriver` gives, whose
 * keys are those of the change path.
 */
export async function openNonceStore(wallet: {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array | undefined;
}): Promise<NonceStore> {
  if (!wallet.privateKey) throw new Error("The wallet has no private key.");

  const material = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(wallet.privateKey),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: KEY_LABEL },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const walletHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(wallet.publicKey))
  );
  const storageKeyOf = (txId: string) => `msigNonce:${hex.encode(walletHash)}:${txId}`;

  /** Reads storage every time: the core's read-back must see what storage holds. */
  async function read(txId: string) {
    const storageKey = storageKeyOf(txId);
    const value = (await storage.local.get(storageKey))[storageKey] as StoredValue | undefined;
    if (value === undefined) return;

    // a value that does not open is never read as "no record": a second nonce would follow
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(value.iv), additionalData: encoder.encode(storageKey) },
        key,
        bytes(value.data)
      );
      const records: StoredRecord[] = JSON.parse(new TextDecoder().decode(plaintext));
      return { createdAt: value.createdAt, records };
    } catch {
      throw new Error("A stored nonce record of this transaction does not open.");
    }
  }

  /** Resolves only when storage has taken the value. */
  async function write(txId: string, records: StoredRecord[], createdAt: number) {
    const storageKey = storageKeyOf(txId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(storageKey) },
      key,
      encoder.encode(JSON.stringify(records))
    );
    const value: StoredValue = {
      v: 1,
      createdAt,
      inputs: records.length,
      iv: hex.encode(iv),
      data: hex.encode(new Uint8Array(data))
    };
    await storage.local.set({ [storageKey]: value });
  }

  return {
    async get(txId, input) {
      const record = (await read(txId))?.records.find((r) => r.input === input);
      if (!record) return;

      return {
        txId,
        input,
        column: record.column,
        publicKey: bytes(record.publicKey),
        nonce: bytes(record.nonce),
        commitment: bytes(record.commitment),
        challenge: record.challenge === null ? undefined : bytes(record.challenge),
        simulated: record.simulated.map((proof) => ({
          column: proof.column,
          commitment: bytes(proof.commitment),
          challenge: bytes(proof.challenge),
          response: bytes(proof.response)
        }))
      };
    },

    async put(records: readonly NonceRecord[]) {
      const txId = records[0]?.txId;
      if (txId === undefined) return;
      if (records.some((record) => record.txId !== txId)) {
        throw new Error("A put holds the records of one transaction.");
      }

      // the read, the check and the write of every window run one at a time
      await navigator.locks.request(LOCK_NAME, async () => {
        const stored = await read(txId);
        const all = stored?.records ?? [];
        for (const record of records) {
          // a stored nonce is never replaced
          if (all.some(({ input }) => input === record.input)) {
            throw new Error(`Input ${record.input} has a stored nonce record.`);
          }
          all.push({
            input: record.input,
            column: record.column,
            publicKey: hex.encode(record.publicKey),
            nonce: hex.encode(record.nonce),
            commitment: hex.encode(record.commitment),
            ...toStored({ challenge: record.challenge, simulated: record.simulated })
          });
        }
        await write(txId, all, stored?.createdAt ?? Date.now());
      });
    },

    async bind(txId: string, bindings: readonly Binding[]) {
      await navigator.locks.request(LOCK_NAME, async () => {
        const stored = await read(txId);
        const records = stored?.records ?? [];
        let changed = false;
        for (const binding of bindings) {
          const at = records.findIndex(({ input }) => input === binding.input);
          const record = records[at];
          if (!record) throw new Error(`Input ${binding.input} has no nonce record.`);

          const bound = toStored(binding);
          if (record.challenge === null) {
            records[at] = { ...record, ...bound };
            changed = true;
          } else if (bindingText(record) !== bindingText(bound)) {
            throw new Refusal(
              "N3",
              `the nonce of input ${binding.input} is bound to another challenge`,
              { input: binding.input, column: record.column }
            );
          }
        }
        if (changed) await write(txId, records, stored?.createdAt ?? Date.now());
      });
    }
  };
}
