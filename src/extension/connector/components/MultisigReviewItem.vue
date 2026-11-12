<script setup lang="ts">
import { computed } from "vue";
import { BanIcon, CircleDashedIcon, CornerDownLeftIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useAssetsStore } from "@/stores/assetsStore";
import { bn, decimalize } from "@/common/bigNumber";
import { ERG_DECIMALS } from "@/constants/ergo";
import type { Reading } from "@/extension/connector/multisig/review";

interface Props {
  position: number;
  /** Absent until the window has read the item. */
  reading?: Reading;
}

const props = defineProps<Props>();

const { t } = useI18n();
const assets = useAssetsStore();

/** The wallet's M of N of each distinct input, in order of appearance. */
const thresholds = computed(() => {
  if (!props.reading?.ok) return [];
  const seen = new Set(
    props.reading.review.inputs.map(({ k, n }) => t("connector.multisig.threshold", { k, n }))
  );
  return [...seen];
});

/** Exact, never shortened: the signer reads what the wallet pays. */
function amount(raw: bigint, decimals = 0) {
  return decimalize(bn(raw), decimals).toFormat();
}

const erg = (nanoErgs: bigint) => `${amount(nanoErgs, ERG_DECIMALS)} ERG`;
</script>

<template>
  <li class="bg-card text-card-foreground flex flex-col gap-3 rounded-xl border px-4 py-3">
    <div class="flex items-center justify-between gap-2">
      <span class="font-semibold">{{ t("connector.multisig.item", { position }) }}</span>

      <span v-if="!reading" class="text-muted-foreground flex items-center gap-1.5 text-xs">
        <CircleDashedIcon class="size-4" aria-hidden="true" />
        {{ t("connector.multisig.notRead") }}
      </span>
      <span v-else-if="!reading.ok" class="text-destructive flex items-center gap-1.5 text-xs">
        <BanIcon class="size-4" aria-hidden="true" />
        {{ t("connector.multisig.refused") }}
      </span>
    </div>

    <p v-if="reading && !reading.ok" class="text-xs break-words">{{ reading.message }}</p>

    <dl v-else-if="reading?.ok" class="flex flex-col gap-3 text-xs">
      <div>
        <dt class="text-muted-foreground">{{ t("connector.multisig.transactionId") }}</dt>
        <dd class="font-mono break-all">{{ reading.review.txId }}</dd>
      </div>

      <div>
        <dt class="text-muted-foreground">{{ t("connector.multisig.wallet") }}</dt>
        <dd>{{ thresholds.join(", ") }}</dd>
      </div>

      <div
        v-for="(output, index) in reading.review.outputs"
        :key="index"
        class="bg-background flex flex-col gap-2 rounded-lg border p-3"
      >
        <dt class="font-semibold">
          <span v-if="output.toWallet" class="flex items-center gap-1.5">
            <CornerDownLeftIcon class="size-4 shrink-0" aria-hidden="true" />
            {{ t("connector.multisig.returns") }}
          </span>
          <template v-else>{{ t("connector.multisig.pays") }}</template>
        </dt>
        <dd class="flex flex-col gap-2">
          <span class="font-mono break-all">{{ output.address }}</span>
          <span class="font-semibold">{{ erg(output.value) }}</span>
          <span v-for="token in output.tokens" :key="token.id" class="flex flex-col">
            <span class="font-semibold break-words">
              {{ amount(token.amount, assets.metadata.get(token.id)?.decimals) }}
              {{ assets.metadata.get(token.id)?.name }}
            </span>
            <span class="text-muted-foreground font-mono break-all">{{ token.id }}</span>
          </span>
        </dd>
      </div>

      <div>
        <dt class="text-muted-foreground">{{ t("transaction.sign.networkFee") }}</dt>
        <dd>{{ erg(reading.review.fee) }}</dd>
      </div>
    </dl>
  </li>
</template>
