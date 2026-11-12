import {
  addressOf,
  Network,
  openRequest,
  Refusal,
  stepDue,
  type RuleId,
  type SignerKey
} from "@ergo-msig/core";
import { MAINNET } from "@/constants/ergo";
import { gt } from "@/i18n";

export interface ReviewedOutput {
  address: string;
  value: bigint;
  tokens: { id: string; amount: bigint }[];
  /** The output returns to the script the inputs come from. */
  toWallet: boolean;
}

/** What the core read from one request, as the signer sees it. */
export interface Review {
  txId: string;
  /** One entry per input: the wallet's M of N. */
  inputs: { k: number; n: number }[];
  /** Every output in the order of the request, but an output of ERG alone to the fee script. */
  outputs: ReviewedOutput[];
  fee: bigint;
}

export type Failure = { ok: false; code: "refused" | "unsupported"; message: string };
export type Reading = { ok: true; review: Review } | Failure;

/**
 * The rules that say what a request or a wallet script must look like. A retry of such an item
 * never works, so the page is told `unsupported`. Every other rule says whether this signer, this
 * round or these proofs allow the step.
 */
const UNSUPPORTED: ReadonlySet<RuleId> = new Set(["C1", "C2", "C5", "P2", "P3", "R3"]);

/** A refusal of the core: its code follows its rule, its message is the core's own. */
export const refusedBy = (refusal: Refusal): Failure => ({
  ok: false,
  code: UNSUPPORTED.has(refusal.rule) ? "unsupported" : "refused",
  message: refusal.message
});

/**
 * The step of the run is not the step due from this signer. The core does not refuse here:
 * `stepDue` only says which step is due. So the sentence is this wallet's own, translated, and
 * carries no rule id.
 */
const notDue = (step: "commit" | "sign"): Reading => ({
  ok: false,
  code: "refused",
  message: gt(
    step === "commit" ? "connector.multisig.notDueCommit" : "connector.multisig.notDueSign"
  )
});

/**
 * Reads one item for a run of `step`, with public keys only. A refusal of the core is a failure
 * with the core's message. A step that is not due is a failure with this wallet's own sentence.
 * Anything else the core throws is no refusal and is left to the caller.
 */
export function readItem(text: string, keys: SignerKey[], step: "commit" | "sign"): Reading {
  try {
    const request = openRequest(text);
    if (stepDue(text, keys) !== step) return notDue(step);

    const network = MAINNET ? Network.Mainnet : Network.Testnet;
    return {
      ok: true,
      review: {
        txId: request.txId,
        inputs: request.inputs.map(({ k, keys }) => ({ k, n: keys.length })),
        // the core calls an output a fee by its script alone, and such an output can carry
        // tokens: only an output that holds nothing but ERG is the fee and is left out
        outputs: request.outputs
          .filter(({ kind, tokens }) => kind !== "fee" || tokens.length > 0)
          .map(({ script, value, tokens, kind }) => ({
            address: addressOf(script, network),
            value,
            tokens: tokens.map(({ id, amount }) => ({ id, amount })),
            toWallet: kind === "wallet"
          })),
        fee: request.outputs.reduce(
          (sum, { kind, value }) => (kind === "fee" ? sum + value : sum),
          0n
        )
      }
    };
  } catch (error) {
    if (error instanceof Refusal) return refusedBy(error);
    throw error;
  }
}
