import { commit, complete, Refusal, sign, type NonceStore, type SignerKey } from "@ergo-msig/core";
import { gt } from "@/i18n";
import { refusedBy } from "./review";

/** Where one item of an approved run stands. */
export type RunState =
  | { state: "working" }
  | { state: "done"; request: string }
  | { state: "failed"; code: "refused" | "unsupported"; message: string };

/**
 * An item that was readable and takes part in the run. `position` is its place in the call, and
 * `txId` is the id the core read from it.
 */
export interface Job {
  position: number;
  text: string;
  txId: string;
}

/**
 * The state of an item that failed for a reason that is no refusal of the core. That reason may
 * hold a record, a key or a page's words, so one fixed sentence stands for it.
 */
export const runFailed = (step: "commit" | "sign"): RunState => ({
  state: "failed",
  code: "refused",
  message: gt(step === "commit" ? "connector.multisig.runFailed" : "connector.multisig.signFailed")
});

/**
 * Runs `make` on each job in turn, in order, and reports each state as it changes. A refusal of
 * the core stops its item with the core's sentence and the code of its rule. Any other error stops
 * its item with the fixed sentence and is never shown or logged. One item's failure never stops
 * the others. `after` runs once an item is reported done: what it does never changes that item's
 * result.
 */
async function runEach(
  jobs: readonly Job[],
  step: "commit" | "sign",
  report: (position: number, state: RunState) => void,
  make: (job: Job) => Promise<string>,
  after?: (job: Job, request: string) => Promise<void>
) {
  for (const job of jobs) {
    const { position } = job;
    report(position, { state: "working" });

    let request: string;
    try {
      request = await make(job);
    } catch (error) {
      if (error instanceof Refusal) {
        const { code, message } = refusedBy(error);
        report(position, { state: "failed", code, message });
      } else {
        report(position, runFailed(step));
      }
      continue;
    }

    report(position, { state: "done", request });
    // the response is made and bound, so the page gets it whatever happens here
    await after?.(job, request).catch(() => undefined);
  }
}

/** Commits each job in turn. Nothing here reads a secret key. */
export const runCommits = (
  jobs: readonly Job[],
  keys: readonly SignerKey[],
  store: NonceStore,
  report: (position: number, state: RunState) => void
) => runEach(jobs, "commit", report, ({ text }) => commit(text, keys, store));

/**
 * Signs each job in turn. The core reads the secret key of the matched child only. An item whose
 * response completes the transaction has its records removed: the core says so through
 * `complete`, which refuses with P10 while a proof is missing, and that means "not complete",
 * never a failure of the item. A record that stays is removed by the signer in the wallet's
 * settings.
 */
export const runSigns = (
  jobs: readonly Job[],
  keys: readonly SignerKey[],
  store: NonceStore,
  remove: (txId: string) => Promise<void>,
  report: (position: number, state: RunState) => void
) =>
  runEach(
    jobs,
    "sign",
    report,
    ({ text }) => sign(text, keys, store),
    async ({ txId }, request) => {
      try {
        complete(request);
      } catch {
        return;
      }
      await remove(txId);
    }
  );
