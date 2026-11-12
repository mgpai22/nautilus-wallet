/**
 * Multi-sig requests as Minotaur makes them, built with sigma-rust. Nothing here comes from
 * `@ergo-msig/core`: the core is never the only judge of its own input.
 */
import { readFileSync } from "node:fs";
import { ErgoAddress } from "@fleet-sdk/core";
import { base64, hex } from "@fleet-sdk/crypto";
import {
  Address,
  BlockHeaders,
  BoxValue,
  Contract,
  DataInputs,
  ErgoBox,
  ErgoBoxCandidate,
  ErgoBoxCandidateBuilder,
  ErgoBoxCandidates,
  ErgoBoxes,
  ErgoStateContext,
  ErgoTree,
  I64,
  NetworkPrefix,
  Parameters,
  PreHeader,
  ReducedTransaction,
  SecretKey,
  Token,
  TokenAmount,
  TokenId,
  Tokens,
  TxId,
  UnsignedInput,
  UnsignedInputs,
  UnsignedTransaction
} from "ergo-lib-wasm-browser";
import type headersFile from "../fixtures/data/headers.json";
import { addressOf, type TestWallet } from "../fixtures/wallets";

export type MultisigWallet = {
  readonly k: number;
  /** In ascending hex order, so `keys[j]` owns column `j` of every input. */
  readonly keys: readonly Uint8Array[];
  readonly script: Uint8Array;
};

// read as a file, as the mock chain does: Playwright's loader takes no JSON import without an attribute
const { data: headers }: typeof headersFile = JSON.parse(
  readFileSync(new URL("../fixtures/data/headers.json", import.meta.url), "utf8")
);
const BOX_VALUE = 1_000_000_000n;
const FEE = 1_100_000n;
// the GraphQL headers as the wallet's provider maps them for sigma-rust
// (node_modules/@fleet-sdk/blockchain-providers/dist/index.mjs:811-820)
const HEADERS = BlockHeaders.from_json(
  headers.blockHeaders.map((h) => ({
    ...h,
    id: h.headerId,
    timestamp: Number(h.timestamp),
    nBits: Number(h.nBits),
    votes: hex.encode(Uint8Array.from(h.votes))
  }))
);
const HEIGHT = headers.blockHeaders[0].height;
const CONTEXT = new ErgoStateContext(
  PreHeader.from_block_header(HEADERS.get(0)),
  HEADERS,
  Parameters.default_parameters()
);

function vlq(value: number): number[] {
  const bytes: number[] = [];
  for (; value >= 0x80; value >>>= 7) bytes.push((value & 0x7f) | 0x80);
  bytes.push(value);
  return bytes;
}

const boxValue = (value: bigint) => BoxValue.from_i64(I64.from_str(String(value)));

/**
 * A `k` of `n` wallet: the signer's key and `n - 1` co-signer keys made here, in Minotaur's
 * script (minotaur-wallet, apps/wallet/src/action/address.ts:22-38).
 */
export function makeWallet(k: number, n: number, signerKey: Uint8Array): MultisigWallet {
  const cosigners = Array.from({ length: n - 1 }, () =>
    SecretKey.random_dlog().get_address().content_bytes()
  );
  const keys = [signerKey, ...cosigners]
    .map((key) => hex.encode(key))
    .sort()
    .map(hex.decode);
  const script = Uint8Array.of(
    0x10,
    ...vlq(n + 1),
    0x04,
    ...vlq(2 * k), // a signed constant, zigzag encoded
    ...keys.flatMap((key) => [0x08, 0xcd, ...key]),
    0x98,
    0x73,
    0x00,
    0x83,
    ...vlq(n),
    0x08,
    ...keys.flatMap((_, i) => [0x73, ...vlq(i + 1)])
  );

  return { k, keys, script };
}

export type Payment = {
  address: string;
  value: bigint;
  /** Held by the first input box and paid out whole. */
  tokens?: { id: string; amount: bigint }[];
};

/** An output as the builder made it: what a review of the request must show. */
export type BuiltOutput = {
  address: string;
  value: bigint;
  tokens: { id: string; amount: bigint }[];
  /** The output returns to the script the inputs come from. */
  toWallet: boolean;
};

const tokenAmount = (amount: bigint) => TokenAmount.from_i64(I64.from_str(String(amount)));

const addressOfTree = (tree: ErgoTree) =>
  Address.recreate_from_ergo_tree(tree).to_base58(NetworkPrefix.Mainnet);

/** The address of the miner fee script: the same for every transaction. */
export const FEE_ADDRESS = addressOfTree(
  ErgoBoxCandidate.new_miner_fee_box(boxValue(FEE), HEIGHT).ergo_tree()
);

/**
 * A transaction that spends `inputCount` boxes of the wallet's script, 1 ERG each. Its outputs
 * are the payments when given, the rest back to the script, and the fee. It is Minotaur's CSR:
 * the reduced transaction, the sender and the input boxes. `outputs` lists what the builder
 * made, in order, with the fee output left out. A payment to `FEE_ADDRESS` is one of them: its
 * script is the fee script, so the core calls its ERG fee.
 */
export function makeRequest(wallet: MultisigWallet, inputCount: number, ...payments: Payment[]) {
  // sigma-rust consumes a tree it is given, so each use reads the script anew
  const walletAddress = addressOfTree(ErgoTree.from_bytes(wallet.script));
  const contract = () => Contract.new(ErgoTree.from_bytes(wallet.script));
  // the first input box holds every token the payments send, whole
  const sent = new Map<string, bigint>();
  for (const { id, amount } of payments.flatMap(({ tokens }) => tokens ?? []))
    sent.set(id, (sent.get(id) ?? 0n) + amount);

  const boxes = ErgoBoxes.empty();
  for (let i = 0; i < inputCount; i++) {
    const parent = TxId.from_str(hex.encode(crypto.getRandomValues(new Uint8Array(32))));
    const held = new Tokens();
    for (const [id, amount] of i === 0 ? sent : [])
      held.add(new Token(TokenId.from_str(id), tokenAmount(amount)));
    boxes.add(new ErgoBox(boxValue(BOX_VALUE), HEIGHT, contract(), parent, 0, held));
  }

  const built: BuiltOutput[] = [];
  const candidates: ErgoBoxCandidate[] = [];
  for (const payment of payments) {
    const builder = new ErgoBoxCandidateBuilder(
      boxValue(payment.value),
      Contract.pay_to_address(Address.from_base58(payment.address)),
      HEIGHT
    );
    for (const { id, amount } of payment.tokens ?? [])
      builder.add_token(TokenId.from_str(id), tokenAmount(amount));
    candidates.push(builder.build());
    built.push({ ...payment, tokens: payment.tokens ?? [], toWallet: false });
  }
  const paid = payments.reduce((sum, { value }) => sum + value, 0n);
  const rest = BOX_VALUE * BigInt(inputCount) - paid - FEE;
  candidates.push(new ErgoBoxCandidateBuilder(boxValue(rest), contract(), HEIGHT).build());
  built.push({ address: walletAddress, value: rest, tokens: [], toWallet: true });
  const fee = ErgoBoxCandidate.new_miner_fee_box(boxValue(FEE), HEIGHT);
  candidates.push(fee);

  const outputs = new ErgoBoxCandidates(candidates[0]);
  for (const candidate of candidates.slice(1)) outputs.add(candidate);

  const inputs = new UnsignedInputs();
  for (let i = 0; i < boxes.len(); i++)
    inputs.add(UnsignedInput.from_box_id(boxes.get(i).box_id()));
  const unsigned = new UnsignedTransaction(inputs, new DataInputs(), outputs);
  const reduced = ReducedTransaction.from_unsigned_tx(unsigned, boxes, ErgoBoxes.empty(), CONTEXT);

  const csr = JSON.stringify({
    CSR: JSON.stringify({
      reducedTx: base64.encode(reduced.sigma_serialize_bytes()),
      sender: walletAddress,
      inputs: Array.from({ length: boxes.len() }, (_, i) =>
        base64.encode(boxes.get(i).sigma_serialize_bytes())
      )
    })
  });

  return {
    csr,
    txId: unsigned.id().to_str(),
    outputs: built,
    fee: FEE
  };
}

/**
 * The same request as an MSR in which the signers at `columns` (indexes into `wallet.keys`)
 * hold a commitment in every input. A commitment is a point of the curve made here: the
 * reader only checks that it is one.
 */
export function withCommitments(csr: string, wallet: MultisigWallet, columns: number[]): string {
  const { reducedTx, inputs }: { reducedTx: string; inputs: string[] } = JSON.parse(
    JSON.parse(csr).CSR
  );
  const hints = inputs.map(() =>
    wallet.keys.map((_, column) =>
      columns.includes(column)
        ? base64.encode(SecretKey.random_dlog().get_address().content_bytes())
        : ""
    )
  );

  return JSON.stringify({ MSR: JSON.stringify({ tx: reducedTx, boxes: inputs, hints }) });
}

/** The column of `key` in the wallet's scripts. */
export const columnOf = (wallet: MultisigWallet, key: Uint8Array) =>
  wallet.keys.findIndex((k) => hex.encode(k) === hex.encode(key));

/** The public key of the test wallet's address at `index`, as the wallet derives it. */
export async function publicKeyOf(wallet: TestWallet, index = 0): Promise<Uint8Array> {
  const [key] = ErgoAddress.decode(await addressOf(wallet, index)).getPublicKeys();
  return key;
}

/** The cells of an MSR, decoded: `cellsOf(text)[input][column]`. An empty cell has no bytes. */
export function cellsOf(text: string): Uint8Array[][] {
  const { hints }: { hints: string[][] } = JSON.parse(JSON.parse(text).MSR);
  return hints.map((row) => row.map((cell) => base64.decode(cell)));
}
