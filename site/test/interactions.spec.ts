import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

type Mutation = { selector: string; key: "ArrowDown" | "End" | "Home" | "Space" };

interface LabContract {
  name: string;
  route: string;
  figure: string;
  initialValues: string[];
  mutations: Mutation[];
  scrollName: RegExp;
}

const labs: LabContract[] = [
  {
    name: "ensemble spread",
    route: "/docs/data/ensemble-values/",
    figure: "#ensemble-spread-lab",
    initialValues: ["tight"],
    mutations: [{ selector: "[data-ensemble-scenario]", key: "ArrowDown" }],
    scrollName: /Scrollable ensemble spread chart/,
  },
  {
    name: "model disagreement",
    route: "/docs/models/choosing/",
    figure: "#model-disagreement-lab",
    initialValues: ["3"],
    mutations: [{ selector: "[data-timing-hour]", key: "End" }],
    scrollName: /Scrollable paired timing comparison/,
  },
  {
    name: "parcel and inversion",
    route: "/docs/python/derivation-science/",
    figure: "#parcel-lab",
    initialValues: ["eroding", "6"],
    mutations: [
      { selector: "[data-parcel-scenario]", key: "ArrowDown" },
      { selector: "[data-parcel-hours]", key: "Home" },
    ],
    scrollName: /Scrollable parcel and inversion chart/,
  },
  {
    name: "usable lift",
    route: "/docs/python/derivation-science/",
    figure: "#usable-lift-lab",
    initialValues: ["1"],
    mutations: [{ selector: "[data-usable-sink]", key: "End" }],
    scrollName: /Scrollable usable-lift chart/,
  },
  {
    name: "wind shear",
    route: "/docs/learn/reading-a-windgram/",
    figure: "#wind-shear-lab",
    initialValues: ["3"],
    mutations: [{ selector: "[data-shear-hour]", key: "End" }],
    scrollName: /Scrollable wind-shear profile/,
  },
];

const homeContract = {
  route: "/",
  figure: "#home-convective-cycle",
  scrollName: /Scrollable windgram with layer toggles/,
};

async function guardStaticBrowsing(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return externalRequests;
}

async function captureFigureState(figure: Locator) {
  return figure.evaluate((element) => ({
    fields: [...element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    )].map((field) => ({
      id: field.id,
      value: field.value,
      checked: field instanceof HTMLInputElement ? field.checked : null,
      selected: field instanceof HTMLSelectElement
        ? [...field.selectedOptions].map((option) => option.value)
        : null,
    })),
    outputs: [...element.querySelectorAll("output, [aria-live]")].map((output) =>
      (output.textContent ?? "").replace(/\s+/g, " ").trim()),
    svgs: [...element.querySelectorAll(".wg-lab__mount svg, [data-windgram-mount] svg")].map((svg) =>
      svg.outerHTML),
  }));
}

async function fieldValues(figure: Locator) {
  return figure.locator("input, select, textarea").evaluateAll((fields) =>
    fields.map((field) => (field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value),
  );
}

async function assertNativeControls(figure: Locator) {
  const invalid = await figure.locator(".wg-control-group input, .wg-control-group select, .wg-control-group button")
    .evaluateAll((controls) => controls.flatMap((control) => {
      const tag = control.tagName;
      const rect = control.getBoundingClientRect();
      const label = control.closest("label")?.getBoundingClientRect();
      const targetWidth = Math.max(rect.width, label?.width ?? 0);
      const targetHeight = Math.max(rect.height, label?.height ?? 0);
      return ["INPUT", "SELECT", "BUTTON"].includes(tag) &&
        (control as HTMLElement).tabIndex >= 0 && targetWidth >= 24 && targetHeight >= 24
        ? []
        : [`${tag.toLowerCase()}#${control.id || "(no id)"} (${targetWidth}×${targetHeight})`];
    }));
  expect(invalid, "controls must be native, keyboard-focusable, and have a 24 px touch target").toEqual([]);
}

async function tapRangeAwayFromInitial(control: Locator) {
  const box = await control.boundingBox();
  expect(box, "range control needs a rendered touch target").not.toBeNull();
  const value = Number(await control.inputValue());
  const min = Number(await control.getAttribute("min"));
  const max = Number(await control.getAttribute("max"));
  const position = value > (min + max) / 2 ? 4 : box!.width - 4;
  await control.tap({ position: { x: position, y: box!.height / 2 } });
}

async function closeContext(context: BrowserContext, externalRequests: string[]) {
  await context.close();
  expect(externalRequests, "touch browsing attempted external network access").toEqual([]);
}

test.describe("flagship lab reset and keyboard contract", () => {
  for (const lab of labs) {
    test(`${lab.name} changes from native controls and Reset restores its declared state`, async ({ page, baseURL }) => {
      const externalRequests = await guardStaticBrowsing(page, baseURL!);
      await page.goto(lab.route, { waitUntil: "networkidle" });
      const figure = page.locator(lab.figure);
      await expect(figure).toBeVisible();
      const conclusion = figure.locator(".wg-lab__conclusion");
      await expect(conclusion).toBeVisible();
      await expect(conclusion).toContainText("Conclusion.");
      await assertNativeControls(figure);
      expect(await fieldValues(figure), `${lab.name} defaults drifted`).toEqual(lab.initialValues);

      const initial = await captureFigureState(figure);
      for (const mutation of lab.mutations) {
        const control = figure.locator(mutation.selector);
        if (await control.evaluate((element) => element.tagName === "SELECT")) {
          const options = await control.locator("option").evaluateAll((elements) =>
            elements.map((element) => (element as HTMLOptionElement).value),
          );
          await control.selectOption(options.find((value) => !lab.initialValues.includes(value))!);
        } else {
          await control.focus();
          await control.press(mutation.key);
        }
      }
      await expect.poll(async () => JSON.stringify(await captureFigureState(figure))).not.toBe(JSON.stringify(initial));

      const reset = figure.getByRole("button", { name: "Reset" });
      await reset.focus();
      await reset.press("Enter");
      await expect.poll(async () => captureFigureState(figure)).toEqual(initial);
      expect(externalRequests, `${lab.name} attempted external network access`).toEqual([]);
    });
  }

  test("homepage progressive figure resets every overlay to its declared first frame", async ({ page, baseURL }) => {
    const externalRequests = await guardStaticBrowsing(page, baseURL!);
    await page.goto(homeContract.route, { waitUntil: "networkidle" });
    const figure = page.locator(homeContract.figure);
    const controls = figure.locator("input[data-windgram-overlay]");
    await expect(controls).toHaveCount(6);
    await assertNativeControls(figure);

    const initialChecks = await controls.evaluateAll((fields) =>
      fields.map((field) => ({ overlay: (field as HTMLElement).dataset.windgramOverlay, checked: (field as HTMLInputElement).checked })),
    );
    expect(initialChecks).toEqual([
      { overlay: "stability", checked: true },
      { overlay: "wind", checked: true },
      { overlay: "clouds", checked: true },
      { overlay: "boundaryLayerTop", checked: true },
      { overlay: "usableLiftTop", checked: true },
      { overlay: "cloudBase", checked: true },
    ]);
    await expect(figure.getByRole("heading", { name: "A fair-weather convective day" })).toBeVisible();

    const initial = await captureFigureState(figure);
    await figure.locator('input[data-windgram-overlay="wind"]').focus();
    await figure.locator('input[data-windgram-overlay="wind"]').press("Space");
    await expect.poll(async () => captureFigureState(figure)).not.toEqual(initial);
    await figure.getByRole("button", { name: "Reset layers" }).press("Enter");
    await expect.poll(async () => captureFigureState(figure)).toEqual(initial);
    expect(externalRequests, "homepage figure attempted external network access").toEqual([]);
  });
});

test("native lab controls and Reset remain operable in a touch context", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const externalRequests = await guardStaticBrowsing(page, baseURL!);

  for (const lab of labs) {
    await test.step(lab.name, async () => {
      await page.goto(lab.route, { waitUntil: "networkidle" });
      const figure = page.locator(lab.figure);
      const control = figure.locator(lab.mutations[0].selector);
      const initial = await captureFigureState(figure);
      const tagName = await control.evaluate((element) => element.tagName);
      if (tagName === "SELECT") {
        const values = await control.locator("option").evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
        await control.selectOption(values.at(-1)!);
      } else {
        await tapRangeAwayFromInitial(control);
      }
      await expect.poll(async () => captureFigureState(figure)).not.toEqual(initial);
      await figure.getByRole("button", { name: "Reset" }).tap();
      await expect.poll(async () => captureFigureState(figure)).toEqual(initial);
    });
  }

  await page.goto(homeContract.route, { waitUntil: "networkidle" });
  const homeFigure = page.locator(homeContract.figure);
  const initialHome = await captureFigureState(homeFigure);
  await homeFigure.locator('label:has(input[data-windgram-overlay="wind"])').tap();
  await expect.poll(async () => captureFigureState(homeFigure)).not.toEqual(initialHome);
  await homeFigure.getByRole("button", { name: "Reset layers" }).tap();
  await expect.poll(async () => captureFigureState(homeFigure)).toEqual(initialHome);

  await closeContext(context, externalRequests);
});

test("intentional horizontal figure regions are labelled and keyboard-scrollable", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const externalRequests = await guardStaticBrowsing(page, baseURL!);
  const contracts = [
    ...labs.map((lab) => ({ route: lab.route, figure: lab.figure, scrollName: lab.scrollName })),
    homeContract,
  ];

  for (const contract of contracts) {
    await test.step(`${contract.route} ${contract.figure}`, async () => {
      await page.goto(contract.route, { waitUntil: "networkidle" });
      const region = page.locator(contract.figure).getByRole("region", { name: contract.scrollName });
      await expect(region).toHaveAttribute("tabindex", "0");
      const measurements = await region.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      }));
      expect(measurements.scrollWidth, "the labelled region should own intentional overflow")
        .toBeGreaterThan(measurements.clientWidth);
      expect(["auto", "scroll"]).toContain(measurements.overflowX);

      await region.evaluate((element) => { element.scrollLeft = 0; });
      await region.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    });
  }

  expect(externalRequests, "scrollable figures attempted external network access").toEqual([]);
});

test("homepage index reaches each main section", async ({ page, baseURL }) => {
  const externalRequests = await guardStaticBrowsing(page, baseURL!);
  await page.goto("/", { waitUntil: "networkidle" });
  const navigation = page.getByRole("navigation", { name: "Explore this page" });
  const destinations = [
    ["Windgram", "read"],
    ["Build", "build"],
    ["Research", "research"],
    ["Project", "project"],
  ] as const;

  await expect(navigation.getByRole("link")).toHaveCount(destinations.length);
  for (const [name, id] of destinations) {
    const link = navigation.getByRole("link", { name: new RegExp(name, "i") });
    await expect(link).toHaveAttribute("href", `#${id}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }

  expect(externalRequests, "homepage index attempted external network access").toEqual([]);
});

test("research previous and next navigation follows the collection sequence", async ({ page, baseURL }) => {
  const externalRequests = await guardStaticBrowsing(page, baseURL!);
  const route = "/research/forecast-data-validation-failures/";
  await page.goto(route, { waitUntil: "networkidle" });
  const navigation = page.getByRole("navigation", { name: "Research article navigation" });
  const previous = navigation.getByRole("link", { name: /Previous/ });
  const next = navigation.getByRole("link", { name: /Next/ });
  const previousHref = await previous.getAttribute("href");
  const nextHref = await next.getAttribute("href");
  expect(previousHref).toMatch(/^\/research\/.+\/$/);
  expect(nextHref).toMatch(/^\/research\/.+\/$/);

  await next.click();
  await expect(page).toHaveURL(new RegExp(`${nextHref!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await page.goto(route, { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Research article navigation" })
    .getByRole("link", { name: /Previous/ }).click();
  await expect(page).toHaveURL(new RegExp(`${previousHref!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  expect(externalRequests, "article navigation attempted external network access").toEqual([]);
});

test("documentation search returns and opens an indexed guide", async ({ page, baseURL }) => {
  const externalRequests = await guardStaticBrowsing(page, baseURL!);
  await page.goto("/docs/", { waitUntil: "networkidle" });
  const searchButton = page.getByRole("button", { name: "Search" });
  await expect(searchButton).toBeEnabled();
  await searchButton.click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  const searchbox = dialog.getByRole("textbox", { name: "Search" });
  await searchbox.fill("provider transports");
  const result = dialog.getByRole("link", { name: /Provider transports/i }).first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.click();
  await expect(page).toHaveURL(/\/docs\/python\/provider-transports\/$/);
  expect(externalRequests, "documentation search attempted external network access").toEqual([]);
});
