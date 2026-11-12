<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/appStore";
import { useAssetsStore } from "@/stores/assetsStore";
import { useWalletStore } from "@/stores/walletStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { addressesDbService } from "@/database/addressesDbService";
import { connectedDAppsDbService } from "@/database/connectedDAppsDbService";
import { walletsDbService } from "@/database/walletsDbService";
import MultisigReviewItem from "@/extension/connector/components/MultisigReviewItem.vue";
import RequestHeader from "@/extension/connector/components/RequestHeader.vue";
import { readItem, type Reading } from "@/extension/connector/multisig/review";
import { childKeys } from "@/extension/connector/multisig/signerKeys";
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
const isSignRun = computed(() => request.value?.type === InternalRequest.MultisigSign);

const detachBeforeUnloadListener = useEventListener(window, "beforeunload", decline);

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

    const keys = childKeys(stored, addresses.at(-1)?.index ?? 0);
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
 * The answer of the whole run: one entry per item, in the order given. An item the review stopped
 * keeps its code and its reason. Every other item is declined.
 */
function answerOf(items: MultisigArgs["items"]) {
  const declined = t("connector.multisig.declined");
  return success(
    items.map(({ id }, position): MultisigEntry => {
      const reading = readings.value[position];
      return reading && !reading.ok
        ? { id, ok: false, code: reading.code, message: reading.message }
        : { id, ok: false, code: "declined", message: declined };
    })
  );
}

/** A promise takes the first value only. */
function decline() {
  if (!request.value) return;
  request.value.resolve(answerOf(request.value.data.items));
}

function cancel() {
  decline();
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
      />
    </ul>
  </ScrollArea>

  <Button class="w-full" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button>
</template>
