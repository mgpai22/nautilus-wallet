import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { WALLET_A } from "../fixtures/wallets";
import { clickToClose, connectDapp } from "../pages/connector";
import { DECLINE, makeItems, reviewRows, runMultisig, withReviewWindow } from "./helpers";

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
 * Presses Tab from the top of the window until the focus leaves or comes round, and reports
 * for each stop whether its focus ring differs from the same element without focus. `capture`
 * runs on every stop, to put its state on file.
 */
async function walkTabStops(win: Page, capture: (name: string) => Promise<unknown>) {
  await win.bringToFront();
  await win.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    Object.assign(window, { tabSnaps: [] });
  });

  for (let i = 0; i < 30; i++) {
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
        (el.matches("button, a, input") ? el.textContent?.trim() : "scroll area") ??
        ""
      );
    });

    if (name === undefined) break;
    await capture(name);
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
          (el.matches("button, a, input") ? el.textContent?.trim() : "scroll area") ??
          "",
        ring: look !== `${style.outline}|${style.boxShadow}`
      };
    });
  });
}

/**
 * The text in the window that does not meet WCAG AA against its own background, the wallet
 * bar of upstream's shell left out. The check composites every background and opacity from the
 * element up, and reads colours through a canvas so that any CSS colour syntax resolves.
 */
function contrastFailures(win: Page) {
  return win.evaluate(() => {
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
  });
}

test.describe("multisig review window screens", () => {
  test.beforeEach(async ({ popup, context, dapp }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  for (const count of [1, 20]) {
    const label = `${count}-item${count === 1 ? "" : "s"}`;

    // At 365 by 660 in both themes, the list never pushes Decline out of the window or scrolls the
    // page sideways, every control has a focus ring, and muted text meets AA in the dark theme.
    test(`${label} fit the window with focus rings and AA contrast in both themes`, async ({
      context,
      dapp
    }, testInfo) => {
      const { win, result } = await withReviewWindow(context, () =>
        runMultisig(dapp, "commit", makeItems(count, "payroll"))
      );
      await win.setViewportSize(WINDOW_SIZE);
      await expect(reviewRows(win)).toHaveCount(count);
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
          await expect(decline).toBeInViewport({ ratio: 1 });
          await reviewRows(win).first().scrollIntoViewIfNeeded();
        }

        expect(await contrastFailures(win), `${scheme}: text below AA`).toEqual([]);

        const stops = await walkTabStops(win, (name) =>
          shot(`focus-${name.toLowerCase().replace(/\W+/g, "-")}`)
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
