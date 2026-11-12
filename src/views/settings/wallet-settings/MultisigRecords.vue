<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { TrashIcon } from "@lucide/vue";
import { hex } from "@fleet-sdk/crypto";
import { useI18n } from "vue-i18n";
import { useWalletStore } from "@/stores/walletStore";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { log } from "@/common/logger";
import { extractErrorMessage } from "@/common/utils";
import {
  listRecords,
  removeRecords,
  type RecordSummary
} from "@/extension/connector/multisig/nonceStore";

const wallet = useWalletStore();
const { t, d } = useI18n();
const { toast } = useToast();

const records = ref<RecordSummary[]>([]);
const loaded = ref(false);
// the transaction whose removal waits for the signer's answer
const asking = ref<string>();
const removing = ref(false);
const confirmOpen = computed({
  get: () => asking.value !== undefined,
  set: (open) => {
    if (!open) asking.value = undefined;
  }
});

// where the keyboard goes when the confirmation closes: the row button that opened it, or after a
// removal a button of the rows that remain, or else the heading
const list = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const returnTo = shallowRef<HTMLElement>();

function ask(txId: string, event: MouseEvent) {
  asking.value = txId;
  returnTo.value = event.currentTarget as HTMLElement;
}

const publicKey = () => hex.decode(wallet.publicKey);

async function load() {
  records.value = await listRecords(publicKey());
  loaded.value = true;
}

watch(() => wallet.publicKey, load, { immediate: true });

async function remove() {
  if (asking.value === undefined) return;

  try {
    removing.value = true;
    await removeRecords(publicKey(), asking.value);
    asking.value = undefined;
    await load();
    await nextTick();
    returnTo.value = list.value?.querySelector("button") ?? heading.value;
  } catch (e) {
    log.error(e);
    toast({
      title: t("connector.multisig.removeRecordFailed"),
      variant: "destructive",
      description: extractErrorMessage(e)
    });
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <Card role="region" aria-labelledby="multisig-records" class="flex flex-col gap-4 p-6">
    <div class="flex flex-col items-start gap-1">
      <h3
        id="multisig-records"
        ref="heading"
        tabindex="-1"
        class="text-sm leading-none font-medium"
      >
        {{ t("connector.multisig.records") }}
      </h3>
      <div class="text-muted-foreground text-xs hyphens-auto">
        {{ t("connector.multisig.recordsDesc") }}
      </div>
    </div>

    <ul v-if="records.length" ref="list" class="flex flex-col gap-4">
      <li v-for="record in records" :key="record.txId" class="flex items-center gap-4">
        <div class="min-w-0 flex-1">
          <div class="font-mono text-xs break-all">{{ record.txId }}</div>
          <div class="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-xs">
            <span>{{
              t("connector.multisig.inputs", { count: record.inputs }, record.inputs)
            }}</span>
            <span>{{ d(record.createdAt, { dateStyle: "medium" }) }}</span>
          </div>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          :aria-label="t('connector.multisig.removeRecord', { txId: record.txId })"
          @click="ask(record.txId, $event)"
        >
          <TrashIcon />
        </Button>
      </li>
    </ul>
    <div v-else-if="loaded" class="text-muted-foreground text-sm">
      {{ t("connector.multisig.recordsEmpty") }}
    </div>

    <Drawer v-model:open="confirmOpen">
      <DrawerContent :final-focus="returnTo">
        <DrawerHeader>
          <DrawerTitle>{{ t("connector.multisig.removeRecordTitle") }}</DrawerTitle>
          <DrawerDescription>{{ t("connector.multisig.removeRecordDesc") }}</DrawerDescription>
        </DrawerHeader>
        <DrawerFooter class="flex-row gap-4">
          <DrawerClose as-child>
            <Button variant="outline" class="flex-1">{{ t("common.cancel") }}</Button>
          </DrawerClose>
          <Button variant="destructive" class="flex-2" :disabled="removing" @click="remove">{{
            t("common.remove")
          }}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  </Card>
</template>
