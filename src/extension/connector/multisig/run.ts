import { commit, Refusal, type NonceStore, type SignerKey } from "@ergo-msig/core";
import { gt } from "@/i18n";
import { refusedBy } from "./review";

/** Where one item of an approved run stands. */
export type RunState =
  | { state: "working" }
  | { state: "done"; request: string }
  | { state: "failed"; code: "refused" | "unsupported"; message: string };

/** An item that was readable and takes part in the run. `position` is its place in the call. */
export interface Job {
  position: number;
  text: string;
}

/**
 * The state of an item that failed for a reason that is no refusal of the core. That reason may
 * hold a record, a key or a page's words, so one fixed sentence stands for it.
 */
export const runFailed = (): RunState => ({
  state: "failed",
  code: "refused",
  message: gt("connector.multisig.runFailed")
});

/**
 * Commits each job in turn, in order, and reports each state as it changes. A refusal of the core
 * stops its item with the core's sentence and the code of its rule. Any other error stops its item
 * with the fixed sentence and is never shown or logged. One item's failure never stops the others.
 */
export async function runCommits(
  jobs: readonly Job[],
  keys: readonly SignerKey[],
  store: NonceStore,
  report: (position: number, state: RunState) => void
) {
  for (const { position, text } of jobs) {
    report(position, { state: "working" });

    try {
      report(position, { state: "done", request: await commit(text, keys, store) });
    } catch (error) {
      if (error instanceof Refusal) {
        const { code, message } = refusedBy(error);
        report(position, { state: "failed", code, message });
      } else {
        report(position, runFailed());
      }
    }
  }
}
