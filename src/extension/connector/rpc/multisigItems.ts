import type { MultisigItem } from "@/types/d.ts/webext-rpc";

const MAX_ITEMS = 20;
const MAX_ID_LENGTH = 64;
const MAX_REQUEST_LENGTH = 1_000_000;
/** Anything but printable ASCII, a line feed or a carriage return. */
const FOREIGN_CHAR = /[^\x20-\x7e\n\r]/;

/**
 * Runs the item checks in a fixed order: the list, the ids, then the requests. The first check
 * that fails names the refusal.
 * @returns The items built anew as `{ id, request }`, or the `info` of the refusal.
 */
export function readItems(value: unknown): MultisigItem[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) {
    return "Invalid items.";
  }

  const entries: { id?: unknown; request?: unknown }[] = Array.from(value, (entry) =>
    typeof entry === "object" && entry !== null ? entry : {}
  );

  const ids: string[] = [];
  for (const { id } of entries) {
    if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) return "Invalid id.";
    ids.push(id);
  }

  if (new Set(ids).size !== ids.length) return "Duplicate id.";

  const items: MultisigItem[] = [];
  for (const [i, { request }] of entries.entries()) {
    if (
      typeof request !== "string" ||
      request.length > MAX_REQUEST_LENGTH ||
      FOREIGN_CHAR.test(request)
    ) {
      return "Invalid request.";
    }

    items.push({ id: ids[i], request });
  }

  return items;
}
