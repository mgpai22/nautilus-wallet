/**
 * The tests of the BIP39 passphrase. The expected addresses and keys come from sigma-rust: its
 * BIP39 seed and its derivation, never from `HdKey`, from Fleet with a passphrase or from
 * `@scure/bip39`, which the code under test uses. Nothing here imports from `src`, and nothing
 * here needs Playwright at run time, so a unit spec can use it too.
 */
import { base64, hex } from "@fleet-sdk/crypto";
import {
  Address,
  DerivationPath,
  ExtSecretKey,
  Mnemonic,
  NetworkPrefix,
  verify_signature
} from "ergo-lib-wasm-browser";
import type { Page } from "@playwright/test";
import type { TestWallet } from "../fixtures/wallets";
import type { Popup } from "../pages/popup";

const CHANGE_PATH = "m/44'/429'/0'/0";

const rootOf = (mnemonic: string, passphrase: string) =>
  ExtSecretKey.derive_master(Mnemonic.to_seed(mnemonic, passphrase));

/** The change-level node a wallet stores: what `HdKey` of the wallet holds. */
export function expectedChange(mnemonic: string, passphrase: string) {
  const node = rootOf(mnemonic, passphrase)
    .derive(DerivationPath.from_string(CHANGE_PATH))
    .public_key();
  return { publicKey: node.pub_key_bytes(), chainCode: node.chain_code() };
}

/** Address `index` of the wallet, and its public and secret key, at `m/44'/429'/0'/0/index`. */
export function expectedKey(mnemonic: string, passphrase: string, index: number) {
  const key = rootOf(mnemonic, passphrase).derive(
    DerivationPath.from_string(`${CHANGE_PATH}/${index}`)
  );
  const publicKey = key.public_key();

  return {
    address: publicKey.to_address().to_base58(NetworkPrefix.Mainnet),
    publicKey: publicKey.pub_key_bytes(),
    secretKey: key.secret_key_bytes()
  };
}

/** Whether `proof` (hex) is a signature of `message` that sigma-rust accepts under `address`. */
export function proofVerifies(address: string, message: string, proof: string): boolean {
  return verify_signature(
    Address.from_base58(address),
    new TextEncoder().encode(message),
    hex.decode(proof)
  );
}

/**
 * A passphrase made for one test: random, with a leading space, a trailing space and a letter
 * outside ASCII, so a trim or a change of form gives another wallet.
 */
export function madePassphrase(): string {
  return ` ${hex.encode(crypto.getRandomValues(new Uint8Array(6)))}\u00e9 `;
}

/**
 * The version 2 record of the test wallet `WALLET_A` (upstream's `tests/e2e/fixtures/wallets.ts`),
 * as a wallet stored before passphrase support holds it: `encryptSecret` of
 * `src/common/keystore.ts`, as it was before the passphrase was added, made it from
 * `WALLET_A.mnemonic` alone, with `WALLET_A.password` and with the wallet's change-level public
 * key (`02fbb666...89d0b7`) as bound data. A record made at test time would follow any later
 * change of the writer, and would stop being an old record.
 */
export const OLD_RECORD_A = {
  version: 2,
  wrappedKey: {
    by: "password",
    kdf: { name: "pbkdf2", salt: "361817f10ad7e89c16f6114520d7fba9", iterations: 600000 },
    iv: "9858b4a1bcfb903816d1a0d9",
    ciphertext:
      "950994628e1dcb222666f9c0b3b568e43a5eb83acae5303fac8fe05e3de2a3e7a63b551e4bc90775a49d890384a3e3b2"
  },
  iv: "7d674469b2d32006ba7b0dd5",
  ciphertext:
    "4a0684bf103b456da5080719d6c720f646726f9569bf0d994f3b7273b131d935bbf14fb2db05cbfcd7bf82dffecef133ece93a3a5ed6ccd271a64211a932adfbd99c8c1bad4027454f44f6831dd3f1f10936f323112d6b7ac36106b9269eb0d09b402c77204d33f17d00d03c805c3aed103771"
};

/** The restore form, on its secret step with `wallet`'s words pasted in. Nothing is restored yet. */
export async function openSecretStep(popup: Popup, wallet: TestWallet) {
  await popup.goto("/add/import");
  await popup.fillWalletInfo(wallet.name, wallet.password);
  await popup.page.getByRole("button", { name: "Insert a recovery phrase" }).click();
  await popup.page.getByRole("heading", { name: "Wallet secret" }).waitFor();
  await popup.paste(wallet.mnemonic);
}

/** The button that restores, on the secret step. */
export const importButton = (popup: Popup) =>
  popup.page.getByRole("button", { name: "Import", exact: true });

/** Turns the switch on and types the passphrase in both fields. `confirm` is the second entry. */
export async function enterPassphrase(popup: Popup, passphrase: string, confirm = passphrase) {
  await popup.setSwitch("#has-passphrase", true);
  await popup.page.locator("#passphrase").fill(passphrase);
  await popup.page.locator("#confirm-passphrase").fill(confirm);
}

/** Restores `wallet` through the form, with `passphrase` typed twice, and waits for its screen. */
export async function restoreWithPassphrase(popup: Popup, wallet: TestWallet, passphrase: string) {
  await openSecretStep(popup, wallet);
  await enterPassphrase(popup, passphrase);
  await importButton(popup).click();
  await popup.expectWalletLoaded(wallet.name);
}

/** Every key of both storage areas, read by an extension page. */
export function readStorage(popup: Popup): Promise<{ local: object; session: object }> {
  return popup.page.evaluate(async () => ({
    local: await chrome.storage.local.get(),
    session: await chrome.storage.session.get()
  }));
}

/** The storage keys of `storage.local` that start with `prefix`. */
export async function storageKeys(popup: Popup, prefix: string): Promise<string[]> {
  const { local } = await readStorage(popup);
  return Object.keys(local).filter((key) => key.startsWith(prefix));
}

/**
 * Puts `record` under the secret key of the wallet named `name`, in extension storage, and
 * returns that key. The public record names the id.
 */
export async function replaceSecret(popup: Popup, name: string, record: object): Promise<string> {
  return popup.page.evaluate(
    async ({ name, record }) => {
      const stored = await chrome.storage.local.get();
      const keys: string[] = [];
      for (const [key, value] of Object.entries(stored)) {
        const isRecord = key.startsWith("wallet:") && typeof value === "object" && value !== null;
        if (isRecord && "name" in value && value.name === name) {
          keys.push(`walletSecret:${key.slice("wallet:".length)}`);
        }
      }
      if (keys.length !== 1) throw new Error(`wallet records named ${name}: ${keys.length}`);

      await chrome.storage.local.set({ [keys[0]]: record });
      return keys[0];
    },
    { name, record }
  );
}

/**
 * The forms in which a stored value could hold `passphrase`: its text, and its UTF-8 bytes as hex
 * and as base64, each without the white space around it, which a trim could cut off.
 */
export function passphraseForms(passphrase: string): string[] {
  const bytes = new TextEncoder().encode(passphrase.trim());
  return [passphrase.trim(), hex.encode(bytes), base64.encode(bytes).replace(/=+$/, "")];
}

/** Whether any of both storage areas holds the passphrase in one of its forms. */
export async function storageHolds(popup: Popup, passphrase: string): Promise<boolean> {
  const dump = JSON.stringify(await readStorage(popup));
  return passphraseForms(passphrase).some((form) => dump.includes(form));
}

/** A page's console messages and page errors, kept as text from now on. */
export function collectConsole(page: Page): string[] {
  const texts: string[] = [];
  page.on("console", (message) => texts.push(message.text()));
  page.on("pageerror", (error) => texts.push(error.message));
  return texts;
}
