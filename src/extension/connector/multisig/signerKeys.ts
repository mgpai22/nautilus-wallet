import type { SignerKey } from "@ergo-msig/core";
import { hex } from "@fleet-sdk/crypto";
import { ErgoHDKey } from "@fleet-sdk/wallet";
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
