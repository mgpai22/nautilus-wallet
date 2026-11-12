<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { CircleDashedIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/appStore";
import { useWalletStore } from "@/stores/walletStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { connectedDAppsDbService } from "@/database/connectedDAppsDbService";
import RequestHeader from "@/extension/connector/components/RequestHeader.vue";
import { AsyncRequest } from "@/extension/connector/rpc/asyncRequestQueue";
import { error, InternalRequest, success } from "@/extension/connector/rpc/protocol";
import { queue } from "@/extension/connector/rpc/uiRpcHandlers";
import { APIErrorCode } from "@/types/connector";
import type { MultisigArgs, MultisigEntry } from "@/types/d.ts/webext-rpc";

const app = useAppStore();
const wallet = useWalletStore();
const { t } = useI18n();

const request = ref<AsyncRequest<MultisigArgs>>();
const walletId = ref(0);
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

/** The answer of the whole run: one entry per item, in the order given. */
function answerOf(items: MultisigArgs["items"]) {
  const message = t("connector.multisig.declined");
  return success(
    items.map(({ id }): MultisigEntry => ({ id, ok: false, code: "declined", message }))
  );
}

/** Nothing is read yet, so every item is declined. A promise takes the first value only. */
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
      <li
        v-for="position in request?.data.items.length ?? 0"
        :key="position"
        class="bg-card text-card-foreground flex items-center justify-between gap-2 rounded-xl border px-4 py-3"
      >
        <span class="font-semibold">{{ t("connector.multisig.item", { position }) }}</span>
        <span class="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CircleDashedIcon class="size-4" aria-hidden="true" />
          {{ t("connector.multisig.notRead") }}
        </span>
      </li>
    </ul>
  </ScrollArea>

  <Button class="w-full" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button>
</template>
