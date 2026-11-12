import type { SignerKey } from "@ergo-msig/core";
import { hex } from "@fleet-sdk/crypto";
import { ErgoHDKey } from "@fleet-sdk/wallet";
import type HdKey from "@/chains/ergo/hdKey";
import { CHUNK_DERIVE_LENGTH } from "@/constants/ergo";

/** The change-level node of a wallet, as it is stored: hex, public only. */
interface PublicNode {
  publicKey: string;
  chainCode: string;
}

/**
 * The public keys of the children 0 to `highestIndex` plus the look-ahead of upstream's own
 * address scan, in index order. The key of a multi-sig wallet may never have held funds, so it
 * can sit past the stored addresses. No secret is needed.
 */
export function childKeys(node: PublicNode, highestIndex: number): SignerKey[] {
  const parent = new ErgoHDKey({
    publicKey: hex.decode(node.publicKey),
    chainCode: hex.decode(node.chainCode)
  });

  return Array.from({ length: highestIndex + CHUNK_DERIVE_LENGTH + 1 }, (_, index) => ({
    publicKey: parent.deriveChild(index).publicKey
  }));
}

/**
 * The same keys with a secret half the core can read. A key's `privateKey` is derived from
 * `deriver` when it is read, and the core reads it for the matched child of each input only, so
 * no other child's secret is ever made. The secret goes to the core and nowhere else.
 */
export function withSecrets(
  keys: readonly SignerKey[],
  deriver: Pick<HdKey, "derivePrivateKey">
): SignerKey[] {
  return keys.map(({ publicKey }, index) => ({
    publicKey,
    get privateKey() {
      return deriver.derivePrivateKey(index);
    }
  }));
}
