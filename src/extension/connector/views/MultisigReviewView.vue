<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import type { SignerKey } from "@ergo-msig/core";
import { useRegle } from "@regle/core";
import { useEventListener } from "@vueuse/core";
import { Loader2Icon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/appStore";
import { useAssetsStore } from "@/stores/assetsStore";
import { useWalletStore } from "@/stores/walletStore";
import { Button } from "@/components/ui/button";
import { Form, FormField } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getPrivateDeriver } from "@/chains/ergo/transaction/prover";
import { useActivationDelay } from "@/composables/useActivationDelay";
import { usePasswordPrompt } from "@/composables/usePasswordPrompt";
import { addressesDbService } from "@/database/addressesDbService";
import { connectedDAppsDbService } from "@/database/connectedDAppsDbService";
import { walletsDbService } from "@/database/walletsDbService";
import MultisigReviewItem from "@/extension/connector/components/MultisigReviewItem.vue";
import RequestHeader from "@/extension/connector/components/RequestHeader.vue";
import { openNonceStore, removeRecords } from "@/extension/connector/multisig/nonceStore";
import { readItem, type Reading } from "@/extension/connector/multisig/review";
import {
  runCommits,
  runFailed,
  runSigns,
  type Job,
  type RunState
} from "@/extension/connector/multisig/run";
import { childKeys, withSecrets } from "@/extension/connector/multisig/signerKeys";
import { AsyncRequest } from "@/extension/connector/rpc/asyncRequestQueue";
import { error, InternalRequest, success } from "@/extension/connector/rpc/protocol";
import { queue } from "@/extension/connector/rpc/uiRpcHandlers";
import { APIErrorCode } from "@/types/connector";
import type { MultisigArgs, MultisigEntry } from "@/types/d.ts/webext-rpc";

const app = useAppStore();
const assets = useAssetsStore();
const wallet = useWalletStore();
const { t } = useI18n();

const request = ref<AsyncRequest<MultisigArgs>>();
const walletId = ref(0);
/** One reading per item, in the order given. Empty until the window has read them. */
const readings = shallowRef<Reading[]>([]);
/** The wallet's public signer keys, set when the items are read. A commit needs no secret key. */
let keys: SignerKey[] = [];
/** One state per item, by position, once the run has reached it. */
const runs = ref<(RunState | undefined)[]>([]);
const password = ref("");
/** The password is being checked and the store opened. */
const signing = ref(false);
/** The signer approved: the items are being committed or signed. */
const running = ref(false);

const isSignRun = computed(() => request.value?.type === InternalRequest.MultisigSign);
const canApprove = computed(() => !running.value && readings.value.some((reading) => reading.ok));

const prompt = usePasswordPrompt(
  () => walletId.value,
  () => wallet.name
);
const pwdInput = useTemplateRef("pwd-input");

/**
 * Everything the signer reads that can change after the window opens: the readings and the name
 * and scale of every token, which arrive from the chain later. Each change restarts the wait
 * before the approve control works, so a click aimed at the old text cannot approve the new.
 */
const reviewed = computed(() => [
  readings.value,
  readings.value.flatMap((reading) =>
    reading.ok
      ? reading.review.outputs.flatMap(({ tokens }) =>
          tokens.map(({ id }) => assets.metadata.get(id))
        )
      : []
  )
]);
const activated = useActivationDelay(reviewed);

const detachBeforeUnloadListener = useEventListener(window, "beforeunload", answer);

const { r$ } = useRegle(
  { password },
  { password: { required: prompt.requiredRule() } },
  { autoDirty: false }
);

onMounted(async () => {
  request.value =
    queue.pop(InternalRequest.MultisigCommit) || queue.pop(InternalRequest.MultisigSign);
  if (!request.value) return;

  const connection = await connectedDAppsDbService.getByOrigin(request.value.origin);
  if (!connection || !connection.walletId) {
    request.value.resolve(error(APIErrorCode.Refused, "Unauthorized."));
    window.close();
    return;
  }

  walletId.value = connection.walletId;
  await readItems(request.value, connection.walletId);
});

watch(
  () => app.loading,
  (loading) => setWallet(loading, walletId.value),
  { immediate: true }
);

watch(
  () => walletId.value,
  (walletId) => setWallet(app.loading, walletId),
  { immediate: true }
);

function setWallet(loading: boolean, walletId: number) {
  if (loading || !walletId) return;
  wallet.load(walletId);
}

/**
 * Reads every item with this wallet's public keys only. An item the core refuses, or whose step
 * is not this run's step, is listed with its reason. A failure that is no refusal of the core is
 * shown as one fixed sentence: its own text may hold the page's words.
 */
async function readItems(run: AsyncRequest<MultisigArgs>, walletId: number) {
  const step = run.type === InternalRequest.MultisigSign ? "sign" : "commit";
  const unreadable: Reading = {
    ok: false,
    code: "refused",
    message: t("connector.multisig.readFailed")
  };

  try {
    const [stored, addresses] = await Promise.all([
      walletsDbService.getById(walletId),
      addressesDbService.getByWalletId(walletId)
    ]);
    if (!stored) throw new Error("The wallet is not stored.");

    keys = childKeys(stored, addresses.at(-1)?.index ?? 0);
    readings.value = run.data.items.map(({ request }) => {
      try {
        return readItem(request, keys, step);
      } catch {
        return unreadable;
      }
    });
  } catch {
    readings.value = run.data.items.map(() => unreadable);
  }

  const tokenIds = readings.value.flatMap((reading) =>
    reading.ok ? reading.review.outputs.flatMap(({ tokens }) => tokens.map(({ id }) => id)) : []
  );
  if (tokenIds.length > 0) assets.loadMetadata(tokenIds, { persist: false }).catch(() => undefined);
}

/**
 * The wallet's deriver, taken once for the run, and the store of its records opened over the key
 * the deriver gives. The caller wipes the deriver when it is done with it.
 */
async function openStore() {
  const deriver = await getPrivateDeriver(walletId.value, prompt.passwordOrSession(password.value));

  try {
    return { deriver, store: await openNonceStore(deriver) };
  } catch (e) {
    deriver.neutered();
    throw e;
  }
}

/**
 * The signer approves the whole run once. A wrong password keeps the window and answers nothing.
 * With the right one, each readable item is committed or signed in turn.
 */
async function approve() {
  const run = request.value;
  if (!run || !canApprove.value || !activated.value || signing.value) return;
  if (!(await r$.$validate()).valid) return;

  let opened: Awaited<ReturnType<typeof openStore>> | undefined;
  signing.value = true;
  try {
    opened = await openStore();
  } catch (e) {
    if (await prompt.handleError(e)) {
      nextTick(() => pwdInput.value?.input?.$el.focus());
      return;
    }
    // no other failure is logged or shown: its text may hold a key or a record
  } finally {
    signing.value = false;
  }

  password.value = "";
  r$.$reset();
  running.value = true;

  const jobs: Job[] = readings.value.flatMap((reading, position) =>
    reading.ok
      ? [{ position, text: run.data.items[position].request, txId: reading.review.txId }]
      : []
  );
  const report = (position: number, state: RunState) => (runs.value[position] = state);
  const step = isSignRun.value ? "sign" : "commit";
  if (!opened) {
    for (const { position } of jobs) report(position, runFailed(step));
  } else if (step === "commit") {
    // a commit needs no secret key: the deriver is wiped once the store holds what it needs
    opened.deriver.neutered();
    await runCommits(jobs, keys, opened.store, report);
  } else {
    const { deriver, store } = opened;
    try {
      await runSigns(
        jobs,
        withSecrets(keys, deriver),
        store,
        (txId) => removeRecords(deriver.publicKey, txId),
        report
      );
    } finally {
      deriver.neutered();
    }
  }

  answer();
  detachBeforeUnloadListener();
  window.close();
}

/**
 * The answer of the whole run: one entry per item, in the order given. A finished item keeps its
 * request. An item the review or the run stopped keeps its code and its reason. Every other item
 * is declined.
 */
function answerOf(items: MultisigArgs["items"]) {
  const declined = t("connector.multisig.declined");
  return success(
    items.map(({ id }, position): MultisigEntry => {
      const run = runs.value[position];
      if (run?.state === "done") return { id, ok: true, request: run.request };

      const reading = readings.value[position];
      const stopped = run?.state === "failed" ? run : reading && !reading.ok ? reading : undefined;
      return stopped
        ? { id, ok: false, code: stopped.code, message: stopped.message }
        : { id, ok: false, code: "declined", message: declined };
    })
  );
}

/** A promise takes the first value only. */
function answer() {
  if (!request.value) return;
  request.value.resolve(answerOf(request.value.data.items));
}

function cancel() {
  answer();
  detachBeforeUnloadListener();
  window.close();
}
</script>

<template>
  <RequestHeader
    :i18n-keypath="isSignRun ? 'connector.multisig.signHeader' : 'connector.multisig.commitHeader'"
    :origin="request?.origin"
  />

  <p class="text-center">
    {{ t("connector.multisig.transactions", request?.data.items.length ?? 0) }}
  </p>

  <ScrollArea type="hover" class="-mx-4 min-h-0 grow border-y px-4">
    <ul class="flex flex-col gap-2 py-4">
      <MultisigReviewItem
        v-for="position in request?.data.items.length ?? 0"
        :key="position"
        :position="position"
        :reading="readings[position - 1]"
        :run="runs[position - 1]"
      />
    </ul>
  </ScrollArea>

  <div class="flex flex-col gap-4">
    <Form v-if="canApprove && !prompt.unlocked" @submit="approve">
      <FormField :validation="r$.password">
        <PasswordInput
          ref="pwd-input"
          v-model="password"
          :placeholder="prompt.label"
          :aria-label="prompt.label"
          :disabled="signing"
          class="w-full"
          @blur="r$.password.$touch()"
        />
      </FormField>
    </Form>

    <div class="flex flex-row gap-4">
      <Button class="flex-1" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button>
      <Button v-if="canApprove" class="flex-2" :disabled="signing || !activated" @click="approve">
        <Loader2Icon v-if="signing" class="animate-spin" />
        <template v-else>{{ t("connector.multisig.approve") }}</template>
      </Button>
    </div>
  </div>
</template>
