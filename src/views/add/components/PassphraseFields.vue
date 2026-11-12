<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface FieldValidation {
  $error: boolean;
  $errors: string[];
  $touch(): void;
}

defineProps<{
  disabled?: boolean;
  rules: { passphrase: FieldValidation; confirmPassphrase: FieldValidation };
}>();

const enabled = defineModel<boolean>("enabled", { required: true });
const passphrase = defineModel<string>("passphrase", { required: true });
const confirmPassphrase = defineModel<string>("confirmPassphrase", { required: true });

const { t } = useI18n();
</script>

<!-- The BIP39 passphrase of a restored wallet. Two plain fields: nothing shows their text. -->
<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-4">
      <Label for="has-passphrase" class="flex flex-col items-start gap-1">
        {{ t("wallet.import.hasPassphrase") }}
        <span class="text-muted-foreground text-xs font-normal">
          {{ t("wallet.import.hasPassphraseDesc") }}
        </span>
      </Label>
      <Switch id="has-passphrase" v-model="enabled" :disabled="disabled" />
    </div>

    <template v-if="enabled">
      <div class="flex flex-col space-y-1.5">
        <Label :disabled="disabled" for="passphrase">{{ t("wallet.import.passphrase") }}</Label>
        <Input
          id="passphrase"
          v-model="passphrase"
          :disabled="disabled"
          type="password"
          autocomplete="off"
          :aria-invalid="rules.passphrase.$error"
          :aria-describedby="rules.passphrase.$error ? 'passphrase-error' : undefined"
          @paste.stop
          @blur="rules.passphrase.$touch()"
        />
        <div
          v-if="rules.passphrase.$error"
          id="passphrase-error"
          role="alert"
          data-form-error
          class="text-destructive text-xs"
        >
          <p v-for="message in rules.passphrase.$errors" :key="message">{{ message }}</p>
        </div>
      </div>

      <div class="flex flex-col space-y-1.5">
        <Label :disabled="disabled" for="confirm-passphrase">
          {{ t("wallet.import.confirmPassphrase") }}
        </Label>
        <Input
          id="confirm-passphrase"
          v-model="confirmPassphrase"
          :disabled="disabled"
          type="password"
          autocomplete="off"
          :aria-invalid="rules.confirmPassphrase.$error"
          :aria-describedby="
            rules.confirmPassphrase.$error ? 'confirm-passphrase-error' : undefined
          "
          @paste.stop
          @blur="rules.confirmPassphrase.$touch()"
        />
        <div
          v-if="rules.confirmPassphrase.$error"
          id="confirm-passphrase-error"
          role="alert"
          data-form-error
          class="text-destructive text-xs"
        >
          <p v-for="message in rules.confirmPassphrase.$errors" :key="message">{{ message }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
