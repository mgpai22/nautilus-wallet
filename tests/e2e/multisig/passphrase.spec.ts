import type { BrowserContext, Page } from "@playwright/test";
import { generateMnemonic } from "@fleet-sdk/wallet";
import { expect, test } from "../fixtures/test";
import { addressOf, WALLET_A } from "../fixtures/wallets";
import { clickToClose, connectDapp, invoke, withConnectorWindow } from "../pages/connector";
import type { Popup } from "../pages/popup";
import {
  collectConsole,
  enterPassphrase,
  expectedKey,
  importButton,
  madePassphrase,
  OLD_RECORD_A,
  openSecretStep,
  proofVerifies,
  readStorage,
  replaceSecret,
  restoreWithPassphrase,
  storageHolds,
  storageKeys
} from "./passphrase";

/** The texts of `wallet.import` and `wallet.backup` of en-US. */
const MISMATCH = "Passphrases don't match.";
const REQUIRED = "Passphrase is required.";
const NOT_SHOWN =
  "This wallet also has a passphrase. It is not shown. You need both to restore the wallet.";

type AuthResult = { signedMessage: string; proof: string };

/** Asks `auth` for `address`, types the wallet's password in the window and returns the proof. */
async function authenticate(context: BrowserContext, dapp: Page, address: string) {
  const { win, result } = await withConnectorWindow(context, "auth", () =>
    invoke<AuthResult, { address: string }>(
      dapp,
      ({ address }) => window.ergo.auth(address, "login"),
      { address }
    )
  );
  await win.getByRole("textbox", { name: / password$/ }).fill(WALLET_A.password);
  await clickToClose(win.getByRole("button", { name: "Authenticate" }));

  const outcome = await result;
  if (!outcome.ok) throw new Error(`auth failed: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

/** The receive view of the loaded wallet shows `address` as its default address. */
async function expectDefaultAddress(popup: Popup, address: string) {
  await popup.navigate("receive");
  await expect(popup.page.getByText(address)).toBeVisible();
}

test.describe("restore with a BIP39 passphrase", () => {
  // The passphrase reaches the seed, so the wallet shows the right address, and the unlock derives
  // as the restore does, so the proof is right too. No passphrase sits in the public record, in a
  // setting or in a log.
  test("shows the address of the seed with the passphrase, and signs with its key", async ({
    popup,
    context,
    dapp
  }) => {
    const passphrase = madePassphrase();
    const logs = collectConsole(popup.page);
    await openSecretStep(popup, WALLET_A);
    await enterPassphrase(popup, passphrase);

    for (const field of ["#passphrase", "#confirm-passphrase"]) {
      await expect(popup.page.locator(field)).toHaveAttribute("type", "password");
      // no control shows the text: the field and its label hold no button
      await expect(popup.page.locator(field).locator("xpath=..").getByRole("button")).toHaveCount(
        0
      );
    }

    await importButton(popup).click();
    await popup.expectWalletLoaded(WALLET_A.name);
    const { address } = expectedKey(WALLET_A.mnemonic, passphrase, 0);
    expect(address, "the passphrase moves the address").not.toBe(await addressOf(WALLET_A, 0));
    await expectDefaultAddress(popup, address);

    await connectDapp(context, dapp, WALLET_A.name);
    const { signedMessage, proof } = await authenticate(context, dapp, address);
    expect(proofVerifies(address, signedMessage, proof), "sigma-rust accepts the proof").toBe(true);

    expect(await storageHolds(popup, passphrase), "a stored value holds the passphrase").toBe(
      false
    );
    expect(
      logs.filter((text) => text.includes(passphrase.trim())),
      "console messages of the popup that hold the passphrase"
    ).toEqual([]);
  });

  // The restore stops when the second entry differs or is empty, so one wrong key stroke cannot
  // restore another wallet, and a passphrase of white space is neither refused nor trimmed. regle's
  // sameAs passes an empty second entry, and its required refuses white space.
  test("blocks entries that differ or are empty, and restores a passphrase of one space", async ({
    popup
  }) => {
    await openSecretStep(popup, WALLET_A);
    await popup.setSwitch("#has-passphrase", true);

    // the field whose rule failed: it is marked invalid and points at an announced error
    const blocked = [
      {
        first: "first entry",
        second: "another entry",
        message: MISMATCH,
        other: REQUIRED,
        field: "#confirm-passphrase",
        clean: "#passphrase"
      },
      {
        first: "first entry",
        second: "",
        message: MISMATCH,
        other: REQUIRED,
        field: "#confirm-passphrase",
        clean: "#passphrase"
      },
      {
        first: "",
        second: "",
        message: REQUIRED,
        other: MISMATCH,
        field: "#passphrase",
        clean: "#confirm-passphrase"
      }
    ];
    for (const { first, second, message, other, field, clean } of blocked) {
      const label = JSON.stringify([first, second]);
      await popup.page.locator("#passphrase").fill(first);
      await popup.page.locator("#confirm-passphrase").fill(second);
      await importButton(popup).click();

      await expect(popup.page.getByText(message), label).toBeVisible();
      await expect(popup.page.getByText(other)).toHaveCount(0);
      await expect(popup.page.getByRole("heading", { name: "Wallet secret" })).toBeVisible();
      expect(await storageKeys(popup, "wallet:"), "a wallet was stored").toEqual([]);

      // WCAG 4.1.3, 3.3.1: a screen reader hears the failure and finds it from the field
      await expect(popup.page.locator(field), `${label}: the field is invalid`).toHaveAttribute(
        "aria-invalid",
        "true"
      );
      await expect(popup.page.locator(clean), `${label}: the other field`).not.toHaveAttribute(
        "aria-invalid",
        "true"
      );
      const errorId = await popup.page.locator(field).getAttribute("aria-describedby");
      expect(errorId, `${label}: the field names its error`).toBeTruthy();
      const error = popup.page.locator(`[id="${errorId}"]`);
      await expect(error, `${label}: the error it names`).toHaveText(message);
      await expect(error, `${label}: the error is announced`).toHaveAttribute("role", "alert");
    }

    await popup.page.locator("#passphrase").fill(" ");
    await popup.page.locator("#confirm-passphrase").fill(" ");
    await importButton(popup).click();
    await popup.expectWalletLoaded(WALLET_A.name);
    await expectDefaultAddress(popup, expectedKey(WALLET_A.mnemonic, " ", 0).address);
  });

  // An entry hidden by turning the switch off is not applied, so the wallet restored is the one the
  // form shows.
  test("restores with no passphrase when the switch is turned off after typing", async ({
    popup,
    context,
    dapp
  }) => {
    await openSecretStep(popup, WALLET_A);
    await enterPassphrase(popup, madePassphrase());
    await popup.setSwitch("#has-passphrase", false);
    await importButton(popup).click();
    await popup.expectWalletLoaded(WALLET_A.name);

    const address = await addressOf(WALLET_A, 0);
    await expectDefaultAddress(popup, address);
    await connectDapp(context, dapp, WALLET_A.name);
    const { signedMessage, proof } = await authenticate(context, dapp, address);
    expect(proofVerifies(address, signedMessage, proof), "sigma-rust accepts the proof").toBe(true);
  });

  // A secret stored before passphrases existed reads as the mnemonic alone, with no part taken for
  // a passphrase, and the new form is not required. Old records are not rewritten.
  test("a wallet stored before passphrase support unlocks and signs as before, and its record stays", async ({
    popup,
    context,
    dapp
  }) => {
    await popup.importWallet(WALLET_A);
    // the record that the code before passphrase support wrote for this wallet and password
    const secretKey = await replaceSecret(popup, WALLET_A.name, OLD_RECORD_A);

    await connectDapp(context, dapp, WALLET_A.name);
    const address = await addressOf(WALLET_A, 0);
    const { signedMessage, proof } = await authenticate(context, dapp, address);
    expect(proofVerifies(address, signedMessage, proof), "sigma-rust accepts the proof").toBe(true);

    expect((await readStorage(popup)).local).toHaveProperty([secretKey], OLD_RECORD_A);
  });

  // The backup never shows the passphrase among the words, and it says that the wallet has one, so
  // the words alone do not look like a full backup.
  test("the backup dialog shows the words and says the wallet has a passphrase", async ({
    popup
  }) => {
    const passphrase = madePassphrase();
    await restoreWithPassphrase(popup, WALLET_A, passphrase);

    const page = popup.page;
    await popup.goto("/settings");
    await page.getByRole("tab", { name: "Wallet" }).click();
    await page.getByRole("button", { name: "Back up" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.locator("#backup-password").fill(WALLET_A.password);
    await drawer.getByRole("button", { name: "Show recovery phrase" }).click();

    expect(await popup.readMnemonic()).toEqual(WALLET_A.mnemonic.split(" "));
    await expect(drawer).toContainText(NOT_SHOWN);
    expect(await drawer.innerText(), "the dialog's text holds the passphrase").not.toContain(
      passphrase.trim()
    );
  });
});

test.describe("restore form at the popup's smallest size", () => {
  /**
   * Puts every scrolled box back at the top. Clicks while the form is built scroll a box by
   * script, even one with `overflow: hidden`, and that would reach the fields for the signer.
   */
  const scrollToTop = (page: Page) =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll("*")) el.scrollTop = 0;
      window.scrollTo(0, 0);
    });

  /**
   * Brings `target` fully into the viewport the way a signer does: the mouse wheel over the form.
   * A wheel never scrolls a box with `overflow: hidden`. `scrollIntoView`, `focus`, a click and a
   * fill all do, so none of them reaches a field here.
   */
  async function wheelTo(page: Page, target: ReturnType<Page["locator"]>) {
    const height = page.viewportSize()!.height;
    const form = (await page.locator("form").first().boundingBox())!;
    const x = form.x + form.width / 2;
    const y = (Math.max(form.y, 0) + Math.min(form.y + form.height, height)) / 2;

    await expect(async () => {
      const box = (await target.boundingBox())!;
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, box.y < 0 ? -100 : 100);
      await expect(target).toBeInViewport({ ratio: 1 });
    }, `the wheel brings ${target} into the viewport`).toPass({ timeout: 5_000 });
  }

  /**
   * Reads the boxes of every control of the form and returns those that touch an edge of the
   * scrolling box: the right edge needs 13 px (the 10 px scrollbar and a 3 px focus ring), the
   * left edge 3 px (a ring). The boxes are read only; nothing scrolls. `count` guards against a
   * selector that matches too little.
   */
  const crowdedControls = (page: Page) =>
    page.evaluate(() => {
      const area = document
        .querySelector("[data-slot=scroll-area-viewport]")!
        .getBoundingClientRect();
      const controls = [
        ...document.querySelectorAll(
          "form button[role=combobox], form .grid > div, #has-passphrase, #passphrase, #confirm-passphrase"
        )
      ];
      const crowded = controls
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.right > area.right - 13 || box.left < area.left + 3)
        .map(({ el, box }) => `${el.id || el.className.slice(0, 30)}: ${box.left}..${box.right}`);
      return { count: controls.length, crowded, area: `${area.left}..${area.right}` };
    });

  /** No control sits under the scrollbar or against the edge, at the place the signer stopped. */
  async function expectClearOfEdges(page: Page, count: number) {
    const found = await crowdedControls(page);
    expect(found.count, "controls measured: the select, 24 words, the switch, the fields").toBe(
      count
    );
    expect(
      found.crowded,
      `controls closer to the edges of ${found.area} than the scrollbar and rings need`
    ).toEqual([]);
  }

  // The restore page, taller than the popup, scrolls for the signer. A click or a fill would pass
  // here even when it does not, because the page's own scripts scroll a box with overflow hidden.
  // The scrollbar does not cover the switch or the fields, and focus rings are not cut at the edge
  // of the scrolling box.
  test("reaches the switch and both passphrase fields by wheel, with Import in view", async ({
    popup
  }, testInfo) => {
    const page = popup.page;
    const capture = (state: string, theme: "light" | "dark") =>
      page.screenshot({ path: testInfo.outputPath(`restore-small-${state}-${theme}.png`) });
    await page.setViewportSize({ width: 360, height: 600 });
    await openSecretStep(popup, {
      name: "Small",
      mnemonic: generateMnemonic(256),
      password: "correct horse battery"
    });
    await expect(page.locator("form .grid input")).toHaveCount(24);
    await scrollToTop(page);

    const controls = {
      switch: page.locator("#has-passphrase"),
      passphrase: page.locator("#passphrase"),
      confirm: page.locator("#confirm-passphrase")
    };

    // the switch is off: Import shows with no scroll, and the switch can be reached
    await expect(importButton(popup)).toBeInViewport({ ratio: 1 });
    await capture("switch-off", "light");
    await wheelTo(page, controls.switch);
    await expect(importButton(popup)).toBeInViewport({ ratio: 1 });
    await expectClearOfEdges(page, 26);

    // a click at the switch's place turns it on: no script scrolls the page to it
    const box = (await controls.switch.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(controls.switch).toHaveAttribute("aria-checked", "true");
    await expect(importButton(popup)).toBeInViewport({ ratio: 1 });

    for (const [field, state] of [
      [controls.passphrase, "switch-on-passphrase"],
      [controls.confirm, "switch-on-confirm"],
      [controls.switch, undefined]
    ] as const) {
      await wheelTo(page, field);
      await expect(importButton(popup)).toBeInViewport({ ratio: 1 });
      await expectClearOfEdges(page, 28);
      if (state) await capture(state, "light");
    }

    // the keyboard focus ring on the field, in both themes: Tab moves from the switch
    await page.keyboard.press("Tab");
    await expect(controls.passphrase).toBeFocused();
    await wheelTo(page, controls.passphrase);
    await capture("switch-on-focus-passphrase", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await capture("switch-on-focus-passphrase", "dark");

    // back at the top, in the dark theme
    await page.mouse.wheel(0, -1000);
    await expect(page.getByRole("heading", { name: "Wallet secret" })).toBeInViewport({ ratio: 1 });
    await page.emulateMedia({ colorScheme: "dark" });
    await capture("switch-on-rest", "dark");
  });
});
