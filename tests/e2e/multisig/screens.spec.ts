import type { Locator, Page } from "@playwright/test";
import { generateMnemonic } from "@fleet-sdk/wallet";
import { expect, test } from "../fixtures/test";
import { RECIPIENT_ADDRESS, TEST_TOKEN, WALLET_A } from "../fixtures/wallets";
import { clickToClose, connectDapp } from "../pages/connector";
import { DECLINE, reviewRows, runMultisig, withReviewWindow } from "./helpers";
import { makeRequest, makeWallet, publicKeyOf } from "./requests";
import { importButton, openSecretStep } from "./passphrase";

/** The size the background opens the connector window at (`src/common/uiHelpers.ts`). */
const WINDOW_SIZE = { width: 365, height: 660 };
const SCHEMES = ["light", "dark"] as const;

/** Everything that can scroll sideways, and whether the page itself scrolls. */
function pageOverflow(win: Page) {
  return win.evaluate(() => {
    const root = document.documentElement;
    return {
      sideways: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
      vertical: root.scrollHeight - root.clientHeight
    };
  });
}

/** Whether a scroll area around the rows holds more than it shows. */
function rowsScroll(win: Page) {
  return win.evaluate(() => {
    const row = document.querySelector("li, [role=listitem]");
    for (let n = row?.parentElement; n; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) {
        return true;
      }
    }
    return false;
  });
}

type Stop = { name: string; ring: boolean };

/**
 * Presses Tab from the top of the window, or from `start`, until the focus leaves or comes
 * round, and reports for each stop whether its focus ring differs from the same element without
 * focus. A stop with no text is named by its id. `capture` runs on every stop, to put its state
 * on file. Twenty reviews hold many stops.
 */
async function walkTabStops(
  win: Page,
  capture: (name: string, stop: number) => unknown,
  start?: Locator
) {
  await win.bringToFront();
  await win.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    Object.assign(window, { tabSnaps: [] });
  });
  await start?.focus();

  for (let i = 0; i < 300; i++) {
    await win.keyboard.press("Tab");
    const name = await win.evaluate(async () => {
      const snaps = (window as unknown as { tabSnaps: { el: Element; look: string }[] }).tabSnaps;
      const el = document.activeElement as HTMLElement;
      if (el === document.body || snaps.some((s) => s.el === el)) return undefined;

      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
      const style = getComputedStyle(el);
      snaps.push({ el, look: `${style.outline}|${style.boxShadow}` });
      return (
        el.getAttribute("aria-label") ??
        (el.matches("button, a, input") ? el.textContent?.trim() || el.id : "scroll area") ??
        ""
      );
    });

    if (name === undefined) break;
    await capture(name, i);
  }

  return win.evaluate(async (): Promise<Stop[]> => {
    const snaps = (window as unknown as { tabSnaps: { el: Element; look: string }[] }).tabSnaps;
    (document.activeElement as HTMLElement).blur();
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));

    return snaps.map(({ el, look }) => {
      const style = getComputedStyle(el);
      return {
        name:
          el.getAttribute("aria-label") ??
          (el.matches("button, a, input") ? el.textContent?.trim() || el.id : "scroll area") ??
          "",
        ring: look !== `${style.outline}|${style.boxShadow}`
      };
    });
  });
}

/**
 * The text in the window that does not meet WCAG AA against its own background, the wallet
 * bar of upstream's shell left out. `within` limits the check to the text inside matching
 * elements. The check composites every background and opacity from the element up, and reads
 * colours through a canvas so that any CSS colour syntax resolves.
 */
function contrastFailures(win: Page, within?: string) {
  return win.evaluate((within) => {
    type Rgba = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const rgba = (css: string): Rgba => {
      ctx.fillStyle = "#010203";
      ctx.fillStyle = css;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (r === 1 && g === 2 && b === 3 && a === 255) throw new Error(`unreadable colour ${css}`);
      return [r, g, b, a / 255];
    };

    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      const mix = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };

    const luminance = ([r, g, b]: Rgba) => {
      const lin = (c: number) =>
        c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };

    const backdrop = (el: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const layer = rgba(getComputedStyle(n).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 0.999) break;
      }
      return layers
        .reverse()
        .reduce((below, layer) => over(layer, below), [255, 255, 255, 1] as Rgba);
    };

    const root = document.querySelector("#app > div")!;
    const failures: { text: string; ratio: number }[] = [];

    for (const el of root.querySelectorAll("*")) {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim())
        .join(" ")
        .trim();
      if (!text || root.firstElementChild?.contains(el) || !el.checkVisibility()) continue;
      if (within && !el.closest(within)) continue;
      if (el.closest(":disabled, [aria-disabled=true]")) continue;

      const style = getComputedStyle(el);
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        opacity *= Number(getComputedStyle(n).opacity);
      }

      const back = backdrop(el);
      const fore = rgba(style.color);
      const shown = over([fore[0], fore[1], fore[2], fore[3] * opacity], back);
      const [light, dark] = [luminance(shown), luminance(back)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);

      const px = Number.parseFloat(style.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push({ text: text.slice(0, 40), ratio });
    }

    return failures;
  }, within);
}

/**
 * `count` requests of a 2 of 3 wallet whose signer is Alice, each with a payment that carries a
 * token, so a review is as tall as it gets. Each item reads on its own.
 */
async function readableItems(count: number) {
  const signer = await publicKeyOf(WALLET_A, 0);
  const built = Array.from({ length: count }, () =>
    makeRequest(makeWallet(2, 3, signer), 1, {
      address: RECIPIENT_ADDRESS,
      value: 123_456_789n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 12_345n }]
    })
  );

  return {
    items: built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr })),
    txIds: built.map(({ txId }) => txId)
  };
}

test.describe("multisig review window screens", () => {
  test.beforeEach(async ({ popup, context, dapp, chain }) => {
    chain.addToken(TEST_TOKEN);
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  const cases = [
    { label: "1-item", readable: 1, refused: 0 },
    { label: "20-items", readable: 20, refused: 0 },
    { label: "refused-item", readable: 1, refused: 1 }
  ];

  for (const { label, readable, refused } of cases) {
    const count = readable + refused;

    // At 365 by 660 in both themes, a review of one, twenty or a refused item never pushes Decline
    // out of the window or scrolls the page sideways, every control has a focus ring, and muted
    // text meets AA in the dark theme.
    test(`${label} fit the window with focus rings and AA contrast in both themes`, async ({
      context,
      dapp
    }, testInfo) => {
      test.setTimeout(180_000);
      const { items, txIds } = await readableItems(readable);
      if (refused) items.push({ id: "payroll-refused", request: "this is not a request" });

      const { win, result } = await withReviewWindow(context, () =>
        runMultisig(dapp, "commit", items)
      );
      await win.setViewportSize(WINDOW_SIZE);
      await expect(reviewRows(win)).toHaveCount(count);
      // every item is read: a transaction id for the readable ones, the core's reason for the other
      for (const [i, txId] of txIds.entries()) {
        await expect(reviewRows(win).nth(i)).toContainText(txId);
      }
      if (refused) await expect(reviewRows(win).last()).toContainText(/C5: /);
      await expect(win.getByText(/not read/i)).toHaveCount(0);
      const decline = win.getByRole("button", { name: DECLINE });

      for (const scheme of SCHEMES) {
        await win.emulateMedia({ colorScheme: scheme });
        if (scheme === "dark") await expect(win.locator("html")).toHaveClass(/dark/);
        else await expect(win.locator("html")).not.toHaveClass(/dark/);

        const shot = (state: string) =>
          win.screenshot({
            path: testInfo.outputPath(`multisig-review-${label}-${scheme}-${state}.png`)
          });
        await shot("at-rest");

        expect(await pageOverflow(win), `${scheme}: the page scrolls`).toEqual({
          sideways: 0,
          vertical: 0
        });
        await expect(decline).toBeInViewport({ ratio: 1 });

        if (count > 1) {
          expect(await rowsScroll(win), `${scheme}: the rows scroll`).toBe(true);
          await reviewRows(win).last().scrollIntoViewIfNeeded();
          await expect(reviewRows(win).last()).toBeInViewport();
          // the refused row on its own, so the badge and the reason are in a capture
          if (refused) {
            await reviewRows(win)
              .last()
              .screenshot({
                path: testInfo.outputPath(`multisig-review-${label}-${scheme}-refused-row.png`)
              });
          }
          await expect(decline).toBeInViewport({ ratio: 1 });
          await reviewRows(win).first().scrollIntoViewIfNeeded();
        }

        expect(await contrastFailures(win), `${scheme}: text below AA`).toEqual([]);

        // the first stops and Decline are on file: a stop for each of twenty reviews would take minutes
        const stops = await walkTabStops(win, (name, stop) =>
          stop < 4 || name === DECLINE
            ? shot(`focus-${stop}-${name.toLowerCase().replace(/\W+/g, "-")}`)
            : undefined
        );
        expect(
          stops.map((s) => s.name),
          `${scheme}: tab stops`
        ).toContain(DECLINE);
        expect(
          stops.filter((s) => !s.ring),
          `${scheme}: stops without a focus ring`
        ).toEqual([]);
      }

      await clickToClose(decline);
      await result;
    });
  }
});

/** The text the passphrase adds to the secret step: its labels, its hint and its messages. */
const PASSPHRASE_TEXT =
  "label[for=has-passphrase], label[for=passphrase], label[for=confirm-passphrase], [data-form-error]";

test.describe("restore form passphrase screens", () => {
  // On the restore form, the switch and the fields never push Import out of the popup or scroll it
  // sideways, every control has a focus ring and a tab stop, and labels, hints and messages meet AA
  // in the dark theme.
  test("the secret step with 24 words fits the popup with focus rings and AA contrast in both themes", async ({
    popup
  }, testInfo) => {
    test.setTimeout(240_000);
    const page = popup.page;
    await openSecretStep(popup, {
      name: "Screens",
      mnemonic: generateMnemonic(256),
      password: "correct horse battery"
    });
    await expect(page.locator("form .grid input")).toHaveCount(24);

    const states = [
      { label: "off", fields: false, enter: async () => undefined },
      { label: "on", fields: true, enter: () => popup.setSwitch("#has-passphrase", true) },
      {
        label: "mismatch",
        fields: true,
        enter: async () => {
          await page.locator("#passphrase").fill("first entry");
          await page.locator("#confirm-passphrase").fill("second entry");
          await importButton(popup).click();
          await expect(page.getByText("Passphrases don't match.")).toBeVisible();
        }
      }
    ];

    for (const { label, fields, enter } of states) {
      await enter();

      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);

        const shot = (state: string) =>
          page.screenshot({
            path: testInfo.outputPath(`restore-passphrase-${label}-${scheme}-${state}.png`)
          });
        await shot("at-rest");

        expect(
          await pageOverflow(page),
          `${label}, ${scheme}: the page scrolls sideways`
        ).toMatchObject({
          sideways: 0
        });
        await importButton(popup).scrollIntoViewIfNeeded();
        await expect(importButton(popup)).toBeInViewport({ ratio: 1 });

        await expect(page.locator(PASSPHRASE_TEXT).first()).toBeVisible();
        expect(
          await contrastFailures(page, PASSPHRASE_TEXT),
          `${label}, ${scheme}: text below AA`
        ).toEqual([]);

        const stops = await walkTabStops(
          page,
          (name) => shot(`focus-${name.toLowerCase().replace(/\W+/g, "-").slice(0, 40)}`),
          page.locator("form .grid input").last()
        );
        // the switch is named by its label and hint (aria-label), the fields by their ids
        const names = stops.map((s) => s.name);
        expect(
          names.some((name) => name.startsWith("This wallet has a passphrase")),
          `${label}, ${scheme}: the switch is a tab stop: ${names}`
        ).toBe(true);
        expect(names, `${label}, ${scheme}: tab stops`).toEqual(
          expect.arrayContaining([
            ...(fields ? ["passphrase", "confirm-passphrase"] : []),
            "Import"
          ])
        );
        expect(
          stops.filter((s) => !s.ring),
          `${label}, ${scheme}: stops without a focus ring`
        ).toEqual([]);
      }
    }
  });
});
