/** What a standard wallet's keys come from. `passphrase` is "" for a wallet with none. */
export type WalletSecret = { mnemonic: string; passphrase: string };

/** No mnemonic holds it: its words are letters, split by white space. */
const SEPARATOR = "\u001f";

/** The text the keystore encrypts: the mnemonic alone, or the mnemonic, U+001F and the passphrase. */
export function packSecret(mnemonic: string, passphrase = ""): string {
  return passphrase === "" ? mnemonic : `${mnemonic}${SEPARATOR}${passphrase}`;
}

/** Splits at the first U+001F. A text with none is a mnemonic with an empty passphrase. */
export function unpackSecret(secret: string): WalletSecret {
  const at = secret.indexOf(SEPARATOR);
  if (at < 0) return { mnemonic: secret, passphrase: "" };

  return { mnemonic: secret.slice(0, at), passphrase: secret.slice(at + 1) };
}
