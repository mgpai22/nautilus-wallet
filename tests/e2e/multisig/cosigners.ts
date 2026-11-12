/**
 * The co-signers of the multi-sig tests: sigma-rust (`ergo-lib-wasm-browser` 0.28.0) in the test
 * runner, by Minotaur's call sequence (minotaur-wallet, apps/wallet/src/action/multi-sig/
 * commit.ts, sign.ts, codec.ts). No line of `@ergo-msig/core` is imported: the wallet's own
 * commitments and signatures are judged here, never by the core that made them.
 *
 * A co-signer's nonces stay in this module. Nothing here prints a nonce or a key.
 */
import { base64, hex } from "@fleet-sdk/crypto";
import {
  ErgoBox,
  ErgoBoxes,
  extract_hints,
  Propositions,
  ReducedTransaction,
  SecretKeys,
  Transaction,
  TransactionHintsBag,
  verify_tx_input_proof,
  Wallet
} from "ergo-lib-wasm-browser";
import { CONTEXT, cosignerSecret, type MultisigWallet } from "./requests";

/** One cell of the hint matrix: the commitment, the response, and the simulated mark. */
type Cell = { commit: Uint8Array; proof: Uint8Array; simulated: boolean };

/** The string fields of one hint of sigma-rust's hint JSON. */
type Hint = ReadonlyMap<string, string>;

type HintBag = { secretHints: Hint[][]; publicHints: Hint[][] };

type Request = { tx: string; boxes: string[]; hints: string[][] };

/** Each co-signer's nonces by `<tx id>/<column>`, one per input, as Minotaur keeps them. */
const nonces = new Map<string, string[]>();

/** An MSR or a CSR as its inner fields. A CSR reads as an empty hint matrix. */
function readRequest(text: string): Request {
  const outer: Record<string, string> = JSON.parse(text);
  const inner = JSON.parse(outer.MSR ?? outer.CSR);
  if (outer.MSR === undefined) return { tx: inner.reducedTx, boxes: inner.inputs, hints: [] };

  return { tx: inner.tx, boxes: inner.boxes, hints: inner.hints };
}

/** Minotaur's MSR text: the fields in the order `tx`, `boxes`, `hints`. */
const writeRequest = ({ tx, boxes, hints }: Request) =>
  JSON.stringify({ MSR: JSON.stringify({ tx, boxes, hints }) });

/** The hint rows of a request: a CSR has none yet, so every cell is empty. */
function rowsOf({ boxes, hints }: Request, wallet: MultisigWallet): string[][] {
  return hints.length === 0 ? boxes.map(() => wallet.keys.map(() => "")) : hints;
}

const reducedOf = ({ tx }: Request) => ReducedTransaction.sigma_parse_bytes(base64.decode(tx));

function boxesOf({ boxes }: Request) {
  const result = ErgoBoxes.empty();
  for (const box of boxes) result.add(ErgoBox.sigma_parse_bytes(base64.decode(box)));
  return result;
}

/** A commitment is 33 bytes, a response follows as 56, and a simulated cell ends in a 1. */
function readCell(text: string): Cell {
  const bytes = base64.decode(text);
  return {
    commit: bytes.subarray(0, 33),
    proof: bytes.subarray(33, 89),
    simulated: bytes.length > 89 && bytes[89] === 1
  };
}

function writeCell({ commit, proof, simulated }: Cell): string {
  if (proof.length === 0) return base64.encode(commit);

  return base64.encode(Uint8Array.of(...commit, ...proof, ...(simulated ? [1] : [])));
}

const prover = (wallet: MultisigWallet, column: number) => {
  const secrets = new SecretKeys();
  secrets.add(cosignerSecret(wallet, column));
  return Wallet.from_secrets(secrets);
};

/** Each key once, as `CD <key>`: a proposition of sigma-rust's `Propositions`. */
function propositions(keys: string[]): Propositions {
  const result = new Propositions();
  for (const key of new Set(keys)) result.add_proposition_from_byte(hex.decode(`cd${key}`));
  return result;
}

/** sigma-rust's hint JSON, read as text so that every field is a string. */
function readBag(json: string, inputs: number): HintBag {
  const bag: Record<string, Record<string, Record<string, unknown>[]>> = JSON.parse(json);
  const side = (name: string) =>
    Array.from({ length: inputs }, (_, input) =>
      (bag[name]?.[String(input)] ?? []).map(
        (hint) =>
          new Map(
            Object.entries(hint).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
      )
    );

  return { secretHints: side("secretHints"), publicHints: side("publicHints") };
}

/** The hints of one leaf: sigma-rust names child `c` of the root `0-c`. */
const at = (hints: Hint[] | undefined, column: number) =>
  (hints ?? []).filter((hint) => hint.get("position") === `0-${column}`);

/**
 * Minotaur's hint bag from every cell (codec.ts:322-371). With `own`, the signer's cells also
 * carry its nonce as `cmtWithSecret`.
 */
function hintsBag(
  wallet: MultisigWallet,
  cells: Cell[][],
  own: { column: number; nonces: string[] } | undefined
) {
  const pubkey = (column: number) => ({ op: "205", h: hex.encode(wallet.keys[column]) });

  const publicHints = cells.map((row, input) =>
    row.flatMap((cell, column) => {
      if (cell.commit.length === 0) return [];
      const hint = {
        hint: cell.simulated ? "cmtSimulated" : "cmtReal",
        pubkey: pubkey(column),
        type: "dlog",
        a: hex.encode(cell.commit),
        position: `0-${column}`
      };

      return own?.column === column
        ? [hint, { ...hint, hint: "cmtWithSecret", secret: own.nonces[input] }]
        : [hint];
    })
  );
  const secretHints = cells.map((row) =>
    row.flatMap((cell, column) =>
      cell.proof.length === 0
        ? []
        : [
            {
              hint: cell.simulated ? "proofSimulated" : "proofReal",
              pubkey: pubkey(column),
              challenge: hex.encode(cell.proof.subarray(0, 24)),
              proof: hex.encode(cell.proof),
              position: `0-${column}`
            }
          ]
    )
  );

  return TransactionHintsBag.from_json(
    JSON.stringify({
      secretHints: Object.fromEntries(secretHints.entries()),
      publicHints: Object.fromEntries(publicHints.entries())
    })
  );
}

/**
 * Minotaur's fill (codec.ts:241-299): the first proof and the first commitment at the cell's
 * position, and the simulated mark from a proof hint's tag. A cell that does not change keeps its
 * text.
 */
function fill(text: string, secretHints: Hint[], publicHints: Hint[]): string {
  const cell = readCell(text);
  const proof = secretHints.find((hint) => hint.has("proof"))?.get("proof");
  const commit = publicHints.find((hint) => hint.has("a"))?.get("a");
  const filled = writeCell({
    commit: commit === undefined ? cell.commit : hex.decode(commit),
    proof: proof === undefined ? cell.proof : hex.decode(proof),
    simulated:
      cell.simulated ||
      secretHints.some((hint) => hint.get("hint")?.toLowerCase().includes("simulated") === true)
  });

  return filled === writeCell(cell) ? text : filled;
}

/**
 * Minotaur's commit (commit.ts:27-60) for the co-signer at `column`, on an MSR or a CSR. Returns
 * the MSR with that column's commitments. The nonces stay in this module.
 */
export function cosignerCommit(text: string, wallet: MultisigWallet, column: number): string {
  const request = readRequest(text);
  const rows = rowsOf(request, wallet);
  const reduced = reducedOf(request);
  const bag = readBag(
    JSON.stringify(
      prover(wallet, column).generate_commitments_for_reduced_transaction(reduced).to_json()
    ),
    rows.length
  );

  const secrets: string[] = [];
  const hints = rows.map((row, input) => {
    const own = at(bag.publicHints[input], column);
    const commit = own.find((hint) => hint.has("a"))?.get("a");
    const secret = own.find((hint) => hint.has("secret"))?.get("secret");
    if (row[column] !== "" || commit === undefined || secret === undefined)
      throw new Error(`column ${column} of input ${input} cannot commit`);

    secrets.push(secret);
    return row.with(column, base64.encode(hex.decode(commit)));
  });
  nonces.set(`${reduced.unsigned_tx().id().to_str()}/${column}`, secrets);

  return writeRequest({ ...request, hints });
}

/**
 * Minotaur's sign (sign.ts:84-143) for the co-signer at `column`: sign with every cell as a
 * hint, then extract the co-signer's own proof as real and every uncommitted or simulated leaf as
 * simulated.
 */
export function cosignerSign(text: string, wallet: MultisigWallet, column: number): string {
  const request = readRequest(text);
  const rows = rowsOf(request, wallet);
  const reduced = reducedOf(request);
  const txId = reduced.unsigned_tx().id().to_str();
  const own = nonces.get(`${txId}/${column}`);
  if (!own) throw new Error(`column ${column} has not committed to ${txId} here`);

  const cells = rows.map((row) => row.map(readCell));
  const partial = prover(wallet, column).sign_reduced_transaction_multi(
    reduced,
    hintsBag(wallet, cells, { column, nonces: own })
  );
  const simulated = cells.flatMap((row) =>
    row.flatMap((cell, c) =>
      cell.commit.length === 0 || cell.simulated ? [hex.encode(wallet.keys[c])] : []
    )
  );
  const extracted = readBag(
    JSON.stringify(
      extract_hints(
        partial,
        CONTEXT,
        boxesOf(request),
        ErgoBoxes.empty(),
        propositions([hex.encode(wallet.keys[column])]),
        propositions(simulated)
      ).to_json()
    ),
    rows.length
  );
  const hints = rows.map((row, input) =>
    row.map((cell, c) =>
      fill(cell, at(extracted.secretHints[input], c), at(extracted.publicHints[input], c))
    )
  );

  return writeRequest({ ...request, hints });
}

/**
 * Minotaur's completion with an empty wallet (sign.ts:162-180): the signed transaction's bytes.
 * With a response missing, sigma-rust cannot finish the proof and these bytes do not verify.
 */
export function assemble(text: string, wallet: MultisigWallet): Uint8Array {
  const request = readRequest(text);
  const cells = rowsOf(request, wallet).map((row) => row.map(readCell));

  return Wallet.from_secrets(new SecretKeys())
    .sign_reduced_transaction_multi(reducedOf(request), hintsBag(wallet, cells, undefined))
    .sigma_serialize_bytes();
}

/**
 * sigma-rust's verdict on a request's inputs: `verify_tx_input_proof` for every input of the
 * transaction that `assemble` makes of `text`, the boxes taken from `text`. This is the judge of
 * every final transaction in the sign tests.
 */
export function verifyInputs(text: string, wallet: MultisigWallet): boolean[] {
  const transaction = Transaction.sigma_parse_bytes(assemble(text, wallet));
  const boxes = boxesOf(readRequest(text));

  return Array.from({ length: transaction.inputs().len() }, (_, input) =>
    verify_tx_input_proof(input, CONTEXT, transaction, boxes, ErgoBoxes.empty())
  );
}
