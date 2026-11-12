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
  Constant,
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
  NonMandatoryRegisterId,
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
export const CONTEXT = new ErgoStateContext(
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
 * The co-signers' secret keys by column. They stay in this file's map and the co-signer harness
 * (`cosigners.ts`) reads them: a wallet object holds none, so no test can print one.
 */
const cosignerSecrets = new WeakMap<MultisigWallet, Map<number, SecretKey>>();

/**
 * A `k` of `n` wallet: the signer's key and `n - 1` co-signer keys made here, in Minotaur's
 * script (minotaur-wallet, apps/wallet/src/action/address.ts:22-38).
 */
export function makeWallet(k: number, n: number, signerKey: Uint8Array): MultisigWallet {
  const secrets = new Map(
    Array.from({ length: n - 1 }, () => {
      const secret = SecretKey.random_dlog();
      return [hex.encode(secret.get_address().content_bytes()), secret] as const;
    })
  );
  const keys = [hex.encode(signerKey), ...secrets.keys()].sort().map(hex.decode);
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

  const wallet: MultisigWallet = { k, keys, script };
  cosignerSecrets.set(
    wallet,
    new Map(
      keys.flatMap((key, column) => {
        const secret = secrets.get(hex.encode(key));
        return secret ? [[column, secret] as const] : [];
      })
    )
  );
  return wallet;
}

/** The columns of the wallet's co-signers: every column but the signer's own. */
export const cosignerColumns = (wallet: MultisigWallet) => [
  ...(cosignerSecrets.get(wallet)?.keys() ?? [])
];

export function cosignerSecret(wallet: MultisigWallet, column: number): SecretKey {
  const secret = cosignerSecrets.get(wallet)?.get(column);
  if (!secret) throw new RangeError(`column ${column} is not a co-signer of this wallet`);
  return secret;
}

export type Payment = {
  address: string;
  value: bigint;
  /** Held by the first input box and paid out whole. */
  tokens?: { id: string; amount: bigint }[];
  /** Bytes of random data in R4: how a cheap output grows the request (see `makeFullSizeRequest`). */
  register?: number;
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
    if (payment.register)
      builder.set_register_value(
        NonMandatoryRegisterId.R4,
        Constant.from_byte_array(crypto.getRandomValues(new Uint8Array(payment.register)))
      );
    candidates.push(builder.build());
    const { register: _register, ...shown } = payment;
    built.push({ ...shown, tokens: payment.tokens ?? [], toWallet: false });
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
 * The cheapest shape that reaches the call's limit of 1,000,000 characters: ONE input
 * and 175 outputs that each carry a 3,900 byte R4 (a CSR of 921,947 characters). sigma-rust
 * parses a box in a window of 4,096 bytes, so no register can be larger. The core skips a byte
 * register in one step of its output search, and one input means one nonce, one row of cells
 * and one proof to make. The same size from inputs would mean about 170 of each.
 */
export function makeFullSizeRequest(wallet: MultisigWallet, address: string) {
  return makeRequest(
    wallet,
    1,
    ...Array.from({ length: 175 }, () => ({ address, value: 2_000_000n, register: 3_900 }))
  );
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

/** The CSR's own fields, decoded: the reduced transaction and the input boxes, as base64 text. */
export function unpackCsr(text: string): { reducedTx: string; inputs: string[] } {
  return JSON.parse(JSON.parse(text).CSR);
}

/**
 * An MSR as the test reads it, with the key lists of both JSON levels so a test can assert that
 * nothing but `tx`, `boxes` and `hints` rides in a request that leaves the window.
 */
export function unpackMsr(text: string) {
  const outer: Record<string, string> = JSON.parse(text);
  const inner: { tx: string; boxes: string[]; hints: string[][] } = JSON.parse(outer.MSR);
  return {
    outerKeys: Object.keys(outer).sort(),
    innerKeys: Object.keys(inner).sort(),
    tx: inner.tx,
    boxes: inner.boxes,
    hints: inner.hints
  };
}
