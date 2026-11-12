import { commit, Refusal, type NonceRecord } from "@ergo-msig/core";
import { nonceStoreCases } from "@ergo-msig/core/nonce-store-suite";
import { ErgoAddress } from "@fleet-sdk/core";
import { base64, hex } from "@fleet-sdk/crypto";
import { generateMnemonic } from "@fleet-sdk/wallet";
import { beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import HdKey from "@/chains/ergo/hdKey";
import { cellsOf, makeRequest, makeWallet } from "../../../../tests/e2e/multisig/requests";
import { openNonceStore } from "./nonceStore";

type SetOutcome = "write" | "drop";
type HeldSet = { start: () => void; outcome: Promise<SetOutcome> };

// storage.local in memory, as tests/unit/walletsDbService.spec.ts fakes it. A test can hold the
// next set back and then write it or drop it.
const { local, storageApi } = vi.hoisted(() => ({
  local: new Map<string, unknown>(),
  storageApi: { calls: 0, heldSet: undefined as HeldSet | undefined }
}));

vi.mock("webextension-polyfill", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0)); // let calls interleave
  return {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          storageApi.calls++;
          await tick();
          const list = keys === null ? [...local.keys()] : ([] as string[]).concat(keys);
          return Object.fromEntries(
            list.filter((k) => local.has(k)).map((k) => [k, structuredClone(local.get(k))])
          );
        },
        async set(items: Record<string, unknown>) {
          storageApi.calls++;
          const held = storageApi.heldSet;
          storageApi.heldSet = undefined;
          held?.start();
          const outcome = held ? await held.outcome : "write";
          await tick();
          if (outcome === "write") {
            for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
          }
        }
      }
    }
  };
});

/** Holds the next `storage.local.set` until the test settles it. */
function holdNextSet() {
  const started = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<SetOutcome>();
  storageApi.heldSet = { start: started.resolve, outcome: outcome.promise };
  return { started: started.promise, settle: outcome.resolve };
}

/** Resolves once storage has had a call since the count `before`, or a Web Lock has a waiter. */
async function untilStorageOrLock(before: number) {
  while (storageApi.calls === before && !(await navigator.locks.query()).pending?.length);
}

/** The storage keys `action` adds. */
async function keysAdded(action: () => Promise<unknown>) {
  const before = new Set(local.keys());
  await action();
  return [...local.keys()].filter((key) => !before.has(key));
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

function newRecord(txId: string, input: number, column: number): NonceRecord {
  return {
    txId,
    input,
    column,
    publicKey: random(33),
    nonce: random(32),
    commitment: random(33),
    challenge: undefined,
    simulated: []
  };
}

/** Every text and byte run of a stored value, with base64 and JSON texts decoded once more. */
function piecesOf(value: unknown): string[] {
  if (typeof value === "string") {
    const pieces = [value, value.toLowerCase()];
    try {
      pieces.push(...piecesOf(JSON.parse(value)));
    } catch {
      // not JSON
    }
    if (/^[\w+/-]+=*$/.test(value)) {
      try {
        const bytes = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
        pieces.push(hex.encode(Uint8Array.from(bytes, (c) => c.charCodeAt(0))));
      } catch {
        // not base64
      }
    }
    return pieces;
  }
  if (value instanceof ArrayBuffer) return [hex.encode(new Uint8Array(value))];
  if (ArrayBuffer.isView(value)) {
    return [hex.encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
  }
  if (Array.isArray(value) && value.length > 0 && value.every((v) => Number.isInteger(v))) {
    return [hex.encode(Uint8Array.from(value))];
  }
  if (value instanceof Object) return Object.values(value).flatMap(piecesOf);
  return [];
}

/** The nonce as bytes, as hex text and as base64 text, each in the form `piecesOf` gives. */
function formsOf(nonce: Uint8Array): string[] {
  const text = hex.encode(nonce);
  const b64 = base64.encode(nonce).replace(/=+$/, "");
  return [
    text,
    ...[text, b64, b64.replaceAll("+", "-").replaceAll("/", "_")].map((form) => [
      form,
      hex.encode(new TextEncoder().encode(form))
    ])
  ].flat();
}

let alice: HdKey;
let bob: HdKey;

beforeAll(async () => {
  alice = await HdKey.fromMnemonic(generateMnemonic());
  bob = await HdKey.fromMnemonic(generateMnemonic());
});

beforeEach(() => {
  local.clear();
  storageApi.heldSet = undefined;
});

describe("the core's store suite", () => {
  const kept: Uint8Array[] = [];
  const cases = nonceStoreCases(
    async () => {
      local.clear();
      return () => openNonceStore(alice);
    },
    (nonce) => kept.push(nonce)
  );

  // The core's own store tests, run on this store: a put that resolves before its write, a
  // replaced nonce, half a call written, a bind that overwrites, or two binds that both read the
  // unbound record fail them.
  test.each(cases)("$name", async ({ run }) => {
    kept.length = 0;
    await run();

    // Fails if a record is stored in the clear, or holds the nonce in its clear part: the other
    // tests read records only through the store.
    const stored = [...local.keys(), ...local.values()].flatMap(piecesOf);
    const found = kept.filter((nonce) =>
      formsOf(nonce).some((form) => stored.some((piece) => piece.includes(form)))
    );
    expect(found.length, "stored nonces of the case").toBe(0);
  });
});

describe("the nonce store", () => {
  // A store key that does not come from the wallet's secret, or a value that fails to open but
  // reads as "no record" (after which a second commit draws a second nonce), would pass the other
  // tests: they open every store with one wallet.
  it("rejects a record read with another wallet's key", async () => {
    const txId = hex.encode(random(32));
    const aliceStore = await openNonceStore(alice);
    const bobStore = await openNonceStore(bob);
    const [aliceKey] = await keysAdded(() => aliceStore.put([newRecord(txId, 0, 0)]));
    const [bobKey] = await keysAdded(() => bobStore.put([newRecord(txId, 0, 0)]));
    local.set(bobKey, structuredClone(local.get(aliceKey)));

    const bobRejects = await bobStore.get(txId, 0).then(
      () => false,
      (error: unknown) => error instanceof Error
    );
    expect(bobRejects, "the other wallet's get rejects").toBe(true);

    // the same storage key, so only the secret differs
    const wrongSecret = await openNonceStore({
      publicKey: alice.publicKey,
      privateKey: bob.privateKey
    });
    const wrongSecretRejects = await wrongSecret.get(txId, 0).then(
      () => false,
      (error: unknown) => error instanceof Error
    );
    expect(wrongSecretRejects, "the get with another secret rejects").toBe(true);
  });

  // A transaction id left out of the encryption would let a value moved to another transaction
  // open there. The other tests move values between wallets only.
  it("rejects a record moved to another transaction", async () => {
    const [txA, txB] = [hex.encode(random(32)), hex.encode(random(32))];
    const store = await openNonceStore(alice);
    const [keyA] = await keysAdded(() => store.put([newRecord(txA, 0, 0)]));
    const [keyB] = await keysAdded(() => store.put([newRecord(txB, 0, 0)]));
    local.set(keyB, structuredClone(local.get(keyA)));

    const movedRejects = await store.get(txB, 0).then(
      () => false,
      (error: unknown) => error instanceof Error
    );
    expect(movedRejects, "the get of the moved value rejects").toBe(true);
  });

  // A commitment must not leave the window before its record is stored: a put that resolves
  // before storage.local.set did, or a get that answers from memory, fails here.
  it("lets commit return its text only when the record is in storage", async () => {
    const signerKey = ErgoAddress.decode(alice.deriveAddress(0).script).getPublicKeys()[0];
    const wallet = makeWallet(2, 3, signerKey);
    const column = wallet.keys.findIndex((key) => hex.encode(key) === hex.encode(signerKey));
    const { csr, txId } = makeRequest(wallet, 2);
    const keys = [{ publicKey: signerKey }];

    const held = holdNextSet();
    const done = commit(csr, keys, await openNonceStore(alice)).then((text) => ({
      text,
      stored: structuredClone([...local])
    }));
    await held.started;
    held.settle("write");
    const { text, stored } = await done;

    // the storage as it was when commit resolved holds the record of every commitment it returned
    local.clear();
    for (const [key, value] of stored) local.set(key, value);
    const store = await openNonceStore(alice);
    const cells = cellsOf(text);
    expect(cells).toHaveLength(2);
    for (const [input, row] of cells.entries()) {
      const record = await store.get(txId, input);
      expect(record && hex.encode(record.commitment)).toBe(hex.encode(row[column]));
    }

    local.clear();
    const dropped = holdNextSet();
    const lost = commit(csr, keys, await openNonceStore(alice));
    await dropped.started;
    dropped.settle("drop");
    await expect(lost).rejects.toBeInstanceOf(Error);
  });

  // Two windows open two store objects: calls must be ordered across them, or a second window
  // writes from a stale read and replaces a nonce or a binding.
  it("of two windows' puts or binds for one input, lets only the first resolve", async () => {
    const txId = hex.encode(random(32));
    const first = await openNonceStore(alice);
    const second = await openNonceStore(alice);
    const record = newRecord(txId, 0, 0);

    const heldPut = holdNextSet();
    const firstPut = first.put([record]);
    await heldPut.started;
    const putCalls = storageApi.calls;
    const secondPut = second.put([newRecord(txId, 0, 0)]);
    await untilStorageOrLock(putCalls);
    heldPut.settle("write");
    const puts = await Promise.allSettled([firstPut, secondPut]);
    expect(puts.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    const stored = await (await openNonceStore(alice)).get(txId, 0);
    const firstKept = stored !== undefined && hex.encode(stored.nonce) === hex.encode(record.nonce);
    expect(firstKept, "the stored nonce is the first put's").toBe(true);

    const [challenge, other] = [random(24), random(24)];
    const heldBind = holdNextSet();
    const firstBind = first.bind(txId, [{ input: 0, challenge, simulated: [] }]);
    await heldBind.started;
    const bindCalls = storageApi.calls;
    const secondBind = second.bind(txId, [{ input: 0, challenge: other, simulated: [] }]);
    await untilStorageOrLock(bindCalls);
    heldBind.settle("write");
    const binds = await Promise.allSettled([firstBind, secondBind]);
    expect(binds.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    const refusal = (binds[1] as PromiseRejectedResult).reason;
    expect(refusal instanceof Refusal && refusal.rule).toBe("N3");
    const bound = await (await openNonceStore(alice)).get(txId, 0);
    const firstBound =
      bound?.challenge !== undefined && hex.encode(bound.challenge) === hex.encode(challenge);
    expect(firstBound, "the stored challenge is the first bind's").toBe(true);
  });
});
