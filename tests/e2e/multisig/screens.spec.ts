import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { generateMnemonic } from "@fleet-sdk/wallet";
import { expect, test } from "../fixtures/test";
import { RECIPIENT_ADDRESS, TEST_TOKEN, WALLET_A } from "../fixtures/wallets";
import { clickToClose, connectDapp } from "../pages/connector";
import {
  APPROVE,
  approveButton,
  approvedRun,
  DECLINE,
  holdRunAtSecondItem,
  passwordField,
  releaseHold,
  requestOf,
  reviewRows,
  runMultisig,
  withReviewWindow
} from "./helpers";
import { cosignerCommit } from "./cosigners";
import { cosignerColumns, makeRequest, makeWallet, publicKeyOf } from "./requests";
import { importButton, openSecretStep } from "./passphrase";
import {
  commitRecords,
  EMPTY_TEXT,
  openWalletSettings,
  recordsRegion,
  REGION_NAME,
  REMOVAL_WARNING,
  rowRemove,
  WARNING
} from "./records";

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

/**
 * Waits for the finished animations of the window: the buttons fade between themes, so a colour
 * read or captured right after a switch is a colour in the middle of the fade. A spinner never
 * finishes and is left out.
 */
function settled(win: Page) {
  return win.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
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

      // a spinner never finishes: only the finite animations (focus transitions) are waited for
      const finite = document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity);
      await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
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
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));

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

    // a portal (a dialog) sits outside the app's root, so a named scope is searched in the body
    for (const el of (within ? document.body : root).querySelectorAll("*")) {
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
  const wallets = Array.from({ length: count }, () => makeWallet(2, 3, signer));
  const built = wallets.map((wallet) =>
    makeRequest(wallet, 1, {
      address: RECIPIENT_ADDRESS,
      value: 123_456_789n,
      tokens: [{ id: TEST_TOKEN.tokenId, amount: 12_345n }]
    })
  );

  return {
    items: built.map(({ csr }, i) => ({ id: `payroll-${i + 1}`, request: csr })),
    txIds: built.map(({ txId }) => txId),
    wallets
  };
}

/**
 * `count` items for a sign run, as `readableItems` makes them: the wallet commits to each through
 * the window, and the first co-signer of each commits after it. Every item is due for a signature.
 */
async function signableItems(context: BrowserContext, dapp: Page, count: number) {
  const { items, wallets } = await readableItems(count);
  const committed = await approvedRun(context, dapp, "commit", items, WALLET_A.password);

  return committed.map((entry, i) => ({
    id: items[i].id,
    request: cosignerCommit(requestOf(entry), wallets[i], cosignerColumns(wallets[i])[0])
  }));
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
      // the approve control enables a second after the last change, a token's name: let it
      // settle, so its colours are measured at rest and not in the middle of that transition
      await expect(reviewRows(win).first()).toContainText(TEST_TOKEN.name);
      await expect(approveButton(win)).toBeEnabled();
      const decline = win.getByRole("button", { name: DECLINE });

      for (const scheme of SCHEMES) {
        await win.emulateMedia({ colorScheme: scheme });
        if (scheme === "dark") await expect(win.locator("html")).toHaveClass(/dark/);
        else await expect(win.locator("html")).not.toHaveClass(/dark/);
        await settled(win);

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

type RunScreen = {
  /** Controls that must show whole in the window. */
  inView: Locator[];
  /** Tab stops the window must offer. */
  stops: string[];
  /** Whether a text field is among the tab stops. Not checked when absent. */
  field?: boolean;
  /** Runs in each theme before the checks: a control that waits for the delay must be ready. */
  ready?: () => Promise<unknown>;
  /** A row to capture on its own, in each theme. */
  row?: Locator;
};

/**
 * The screen checks for one state of the window in both themes: a capture, no scroll of the
 * page, the named controls whole in the window, text at AA, and keyboard stops with a ring.
 */
async function checkRunScreen(win: Page, testInfo: TestInfo, label: string, screen: RunScreen) {
  for (const scheme of SCHEMES) {
    await win.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") await expect(win.locator("html")).toHaveClass(/dark/);
    else await expect(win.locator("html")).not.toHaveClass(/dark/);
    await settled(win);
    await screen.ready?.();

    const shot = (state: string) =>
      win.screenshot({ path: testInfo.outputPath(`multisig-run-${label}-${scheme}-${state}.png`) });
    await shot("at-rest");
    if (screen.row) {
      // the row itself, scrolled into view, so its state and its spinner are on file
      await screen.row.scrollIntoViewIfNeeded();
      await expect(screen.row).toBeInViewport();
      await screen.row.screenshot({
        path: testInfo.outputPath(`multisig-run-${label}-${scheme}-row.png`)
      });
    }

    expect(await pageOverflow(win), `${label}, ${scheme}: the page scrolls`).toEqual({
      sideways: 0,
      vertical: 0
    });
    for (const target of screen.inView) await expect(target).toBeInViewport({ ratio: 1 });
    expect(await contrastFailures(win), `${label}, ${scheme}: text below AA`).toEqual([]);

    let field = false;
    const stops = await walkTabStops(win, async (name, stop) => {
      field ||= await win.evaluate(() => document.activeElement?.tagName === "INPUT");
      if (stop < 4) await shot(`focus-${stop}-${name.toLowerCase().replace(/\W+/g, "-")}`);
    });
    expect(
      stops.map((s) => s.name),
      `${label}, ${scheme}: tab stops`
    ).toEqual(expect.arrayContaining(screen.stops));
    if (screen.field !== undefined)
      expect(field, `${label}, ${scheme}: a field is a stop`).toBe(screen.field);
    expect(
      stops.filter((s) => !s.ring),
      `${label}, ${scheme}: stops without a focus ring`
    ).toEqual([]);
  }
}

test.describe("multisig run screens", () => {
  test.beforeEach(async ({ popup, context, dapp, chain }) => {
    chain.addToken(TEST_TOKEN);
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // The approve control and the password field stay in the window and clear of the rows, the page
  // never scrolls sideways, every control has a focus ring and a tab stop, and muted text meets AA
  // in the dark theme.
  test("the review with the approve control and the password field fits the window with focus rings and AA contrast in both themes", async ({
    context,
    dapp
  }, testInfo) => {
    test.setTimeout(180_000);
    const { items } = await readableItems(3);

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await win.setViewportSize(WINDOW_SIZE);
    await expect(reviewRows(win)).toHaveCount(3);
    // a token's name arrives after the reading and restarts the delay: wait for it, then for the control
    await expect(reviewRows(win).first()).toContainText(TEST_TOKEN.name);
    const decline = win.getByRole("button", { name: DECLINE });

    await checkRunScreen(win, testInfo, "approval", {
      inView: [approveButton(win), decline, passwordField(win)],
      stops: [APPROVE, DECLINE],
      field: true,
      ready: () => expect(approveButton(win)).toBeEnabled()
    });

    await clickToClose(decline);
    await result;
  });

  // A run's working and done rows never push Decline out of the window or drop the focus ring, and
  // their state text meets AA in both themes.
  test("a run with a row done and a row working fits the window with focus rings and AA contrast in both themes", async ({
    context,
    dapp,
    popup
  }, testInfo) => {
    test.setTimeout(180_000);
    const { items } = await readableItems(3);

    const { win, result } = await withReviewWindow(context, () =>
      runMultisig(dapp, "commit", items)
    );
    await win.setViewportSize(WINDOW_SIZE);
    await expect(reviewRows(win)).toHaveCount(3);
    await expect(approveButton(win)).toBeVisible();

    const hold = await holdRunAtSecondItem(win, popup.page, WALLET_A.password);
    const decline = win.getByRole("button", { name: DECLINE });
    await checkRunScreen(win, testInfo, "working", {
      inView: [decline],
      stops: [DECLINE],
      row: reviewRows(win).nth(1)
    });

    await releaseHold(popup.page, hold);
    const outcome = await result;
    expect(outcome.ok).toBe(true);
  });

  // In a sign run, the approve control and the password field stay in the window and clear of the
  // rows, the page never scrolls sideways, every control has a focus ring and a tab stop, and muted
  // text meets AA in the dark theme.
  test("the review of a sign run with the approve control and the password field fits the window with focus rings and AA contrast in both themes", async ({
    context,
    dapp
  }, testInfo) => {
    test.setTimeout(180_000);
    const items = await signableItems(context, dapp, 3);

    const { win, result } = await withReviewWindow(context, () => runMultisig(dapp, "sign", items));
    await win.setViewportSize(WINDOW_SIZE);
    await expect(reviewRows(win)).toHaveCount(3);
    // a token's name arrives after the reading and restarts the delay: wait for it, then for the control
    await expect(reviewRows(win).first()).toContainText(TEST_TOKEN.name);
    const decline = win.getByRole("button", { name: DECLINE });

    await checkRunScreen(win, testInfo, "sign-approval", {
      inView: [approveButton(win), decline, passwordField(win)],
      stops: [APPROVE, DECLINE],
      field: true,
      ready: () => expect(approveButton(win)).toBeEnabled()
    });

    await clickToClose(decline);
    await result;
  });

  // A sign run's working and done rows never push Decline out of the window or drop the focus ring,
  // and their state text meets AA in both themes.
  test("a sign run with a row done and a row working fits the window with focus rings and AA contrast in both themes", async ({
    context,
    dapp,
    popup
  }, testInfo) => {
    test.setTimeout(180_000);
    const items = await signableItems(context, dapp, 3);

    const { win, result } = await withReviewWindow(context, () => runMultisig(dapp, "sign", items));
    await win.setViewportSize(WINDOW_SIZE);
    await expect(reviewRows(win)).toHaveCount(3);
    await expect(approveButton(win)).toBeVisible();

    const hold = await holdRunAtSecondItem(win, popup.page, WALLET_A.password);
    const decline = win.getByRole("button", { name: DECLINE });
    await checkRunScreen(win, testInfo, "sign-working", {
      inView: [decline],
      stops: [DECLINE],
      row: reviewRows(win).nth(1)
    });

    await releaseHold(popup.page, hold);
    const outcome = await result;
    expect(outcome.ok).toBe(true);
  });
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

type PopupScreen = {
  /** The part of the page whose text is checked for contrast. */
  scope: Locator;
  /** Controls that must show whole in the popup. */
  inView: Locator[];
  /** Tab stops the page must offer, by the start of their name, and how many of each at least. */
  stops: Record<string, number>;
};

/**
 * The screen checks for one state of the settings in both themes, at the popup's size: a capture,
 * no sideways scroll, the named controls whole in the popup, the text of `scope` at AA, and the
 * keyboard stops. Every stop named in `stops` must show a focus ring. The settings of upstream
 * hold more stops: they are not judged here.
 */
async function checkPopupScreen(
  page: Page,
  testInfo: TestInfo,
  label: string,
  screen: PopupScreen
) {
  const names = Object.keys(screen.stops);

  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    await settled(page);

    const shot = (state: string) =>
      page.screenshot({
        path: testInfo.outputPath(`multisig-records-${label}-${scheme}-${state}.png`)
      });
    await shot("at-rest");

    expect(
      await pageOverflow(page),
      `${label}, ${scheme}: the page scrolls sideways`
    ).toMatchObject({
      sideways: 0
    });
    for (const target of screen.inView) {
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeInViewport({ ratio: 1 });
    }

    await screen.scope.evaluate((el) => el.setAttribute("data-scope", ""));
    expect(
      await contrastFailures(page, "[data-scope]"),
      `${label}, ${scheme}: text below AA`
    ).toEqual([]);

    if (names.length === 0) continue;
    const stops = await walkTabStops(page, (name, stop) =>
      names.some((n) => name.startsWith(n))
        ? shot(`focus-${stop}-${name.toLowerCase().replace(/\W+/g, "-").slice(0, 30)}`)
        : undefined
    );
    for (const [prefix, atLeast] of Object.entries(screen.stops)) {
      expect(
        stops.filter((s) => s.name.startsWith(prefix)).length,
        `${label}, ${scheme}: tab stops named ${prefix}`
      ).toBeGreaterThanOrEqual(atLeast);
    }
    expect(
      stops.filter((s) => names.some((n) => s.name.startsWith(n)) && !s.ring),
      `${label}, ${scheme}: stops without a focus ring`
    ).toEqual([]);
  }
}

test.describe("stored records screens", () => {
  test.beforeEach(async ({ popup, context, dapp }) => {
    await popup.importWallet(WALLET_A);
    await connectDapp(context, dapp, WALLET_A.name);
  });

  // The records list and the warning dialog never scroll the popup sideways or push Remove or
  // Cancel out of it, every control keeps its focus ring and tab stop, and muted text meets AA in
  // the dark theme.
  test("the empty list, three records and the warning fit the popup with focus rings and AA contrast in both themes", async ({
    popup,
    context,
    dapp
  }, testInfo) => {
    test.setTimeout(240_000);
    const page = popup.page;
    await page.setViewportSize(WINDOW_SIZE);

    await openWalletSettings(popup);
    const region = recordsRegion(page);
    await expect(region.getByText(EMPTY_TEXT)).toBeVisible();
    await checkPopupScreen(page, testInfo, "empty", { scope: region, inView: [region], stops: {} });

    // The removal warning does not depend on a check made when the drawer opens, so a wallet whose
    // first record is written while the drawer is open still warns before its removal.
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const removal = page.getByRole("dialog");
    await expect(removal, "a wallet with no record").toContainText(REMOVAL_WARNING);
    await checkPopupScreen(page, testInfo, "wallet-removal", {
      scope: removal,
      inView: [removal.getByRole("button", { name: "Cancel" })],
      stops: { Cancel: 1 }
    });
    await removal.getByRole("button", { name: "Cancel" }).click();
    await expect(removal).toBeHidden();

    await commitRecords(context, dapp, WALLET_A, [1, 2, 3]);
    await page.reload();
    await openWalletSettings(popup);
    await expect(region.getByRole("listitem")).toHaveCount(3);
    await expect(region.getByText(EMPTY_TEXT)).toHaveCount(0);
    const removes = rowRemove(region);
    await expect(removes).toHaveCount(3);
    // the three rows' buttons and the wallet's own Remove
    await checkPopupScreen(page, testInfo, "three", {
      scope: region,
      inView: [removes.nth(0), removes.nth(1), removes.nth(2)],
      stops: { Remove: 4 }
    });

    await removes.first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(WARNING);
    await checkPopupScreen(page, testInfo, "warning", {
      scope: dialog,
      inView: [
        dialog.getByRole("button", { name: "Cancel" }),
        dialog.getByRole("button", { name: "Remove", exact: true })
      ],
      stops: { Cancel: 1, Remove: 1 }
    });

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: REGION_NAME })).toBeVisible();
  });
});
