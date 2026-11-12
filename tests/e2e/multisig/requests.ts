/**
 * Multi-sig requests as Minotaur makes them, built with sigma-rust. Nothing here comes from
 * `@ergo-msig/core`: the core is never the only judge of its own input.
 */
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
  Tokens,
  TxId,
  UnsignedInput,
  UnsignedInputs,
  UnsignedTransaction
} from "ergo-lib-wasm-browser";
import headers from "../fixtures/data/headers.json";

export type MultisigWallet = {
  readonly k: number;
  /** In ascending hex order, so `keys[j]` owns column `j` of every input. */
  readonly keys: readonly Uint8Array[];
  readonly script: Uint8Array;
};

const BOX_VALUE = 1_000_000_000n;
const FEE = 1_100_000n;
// the GraphQL headers as the wallet's provider maps them for sigma-rust
// (node_modules/@fleet-sdk/blockchain-providers/dist/index.mjs:811-820)
const HEADERS = BlockHeaders.from_json(
  headers.data.blockHeaders.map((h) => ({
    ...h,
    id: h.headerId,
    timestamp: Number(h.timestamp),
    nBits: Number(h.nBits),
    votes: hex.encode(Uint8Array.from(h.votes))
  }))
);
const HEIGHT = headers.data.blockHeaders[0].height;
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

/**
 * A transaction that spends `inputCount` boxes of the wallet's script, 1 ERG each, back to the
 * script less a fee, as Minotaur's CSR: the reduced transaction, the sender and the input boxes.
 */
export function makeRequest(
  wallet: MultisigWallet,
  inputCount: number
): { csr: string; txId: string } {
  const contract = Contract.new(ErgoTree.from_bytes(wallet.script));
  const boxes = ErgoBoxes.empty();
  for (let i = 0; i < inputCount; i++) {
    const parent = TxId.from_str(hex.encode(crypto.getRandomValues(new Uint8Array(32))));
    boxes.add(new ErgoBox(boxValue(BOX_VALUE), HEIGHT, contract, parent, 0, new Tokens()));
  }

  const change = new ErgoBoxCandidateBuilder(
    boxValue(BOX_VALUE * BigInt(inputCount) - FEE),
    contract,
    HEIGHT
  ).build();
  const outputs = new ErgoBoxCandidates(change);
  outputs.add(ErgoBoxCandidate.new_miner_fee_box(boxValue(FEE), HEIGHT));

  const inputs = new UnsignedInputs();
  for (let i = 0; i < boxes.len(); i++)
    inputs.add(UnsignedInput.from_box_id(boxes.get(i).box_id()));
  const unsigned = new UnsignedTransaction(inputs, new DataInputs(), outputs);
  const reduced = ReducedTransaction.from_unsigned_tx(unsigned, boxes, ErgoBoxes.empty(), CONTEXT);

  const csr = JSON.stringify({
    CSR: JSON.stringify({
      reducedTx: base64.encode(reduced.sigma_serialize_bytes()),
      sender: Address.recreate_from_ergo_tree(ErgoTree.from_bytes(wallet.script)).to_base58(
        NetworkPrefix.Mainnet
      ),
      inputs: Array.from({ length: boxes.len() }, (_, i) =>
        base64.encode(boxes.get(i).sigma_serialize_bytes())
      )
    })
  });

  return { csr, txId: unsigned.id().to_str() };
}

/** The cells of an MSR, decoded: `cellsOf(text)[input][column]`. An empty cell has no bytes. */
export function cellsOf(text: string): Uint8Array[][] {
  const { hints }: { hints: string[][] } = JSON.parse(JSON.parse(text).MSR);
  return hints.map((row) => row.map((cell) => base64.decode(cell)));
}
