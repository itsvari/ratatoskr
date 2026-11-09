import { expect, test } from "@playwright/test";

test("local create and appearance survive reload at desktop and mobile widths", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("button", { name: "New link" })).toBeVisible();
  await page.screenshot({ path: "verification-artifacts/admin-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Title").fill("Browser test");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Browser test").first()).toBeVisible();
  await page.screenshot({ path: "verification-artifacts/admin-populated-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "verification-artifacts/admin-mobile.png", fullPage: true });
  await page.reload();
  await expect(page.getByText("Browser test").last()).toBeVisible();
});

test("creation retries the same command after a dropped response", async ({ page }) => {
  let attempts = 0;
  const requestIds: string[] = [];
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload: unknown = route.request().postDataJSON();
    if (typeof payload === "object" && payload !== null && "requestId" in payload && typeof payload.requestId === "string") {
      requestIds.push(payload.requestId);
    }
    attempts += 1;
    if (attempts === 1) {
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.clock.install();
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.net/");
  const expiry = await page.evaluate(() => {
    const future = new Date(Date.now() + 120_000);
    return new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  await page.getByLabel("Expires").fill(expiry);
  await page.getByLabel("Slug").fill("retry-browser");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be reached");
  await page.clock.fastForward(180_000);
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await page.getByRole("button", { name: "Create another" }).click();
  await page.getByLabel("Destination").fill("https://example.net/");
  await page.getByLabel("Expires").fill(expiry);
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("alert")).toContainText("expiry in the future");
});

test("appearance persists after reload", async ({ page }) => {
  await page.goto("/admin");
  for (const appearance of ["Light", "Dark", "System"]) {
    await page.getByRole("combobox", { name: "Appearance" }).click();
    await page.getByRole("option", { name: appearance }).click();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Appearance" })).toContainText(appearance);
    if (appearance === "Light") await page.screenshot({ path: "verification-artifacts/admin-light.png", fullPage: true });
  }
});

test("local edits, revocation, restoration, preview and settings", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.com/");
  await page.getByLabel("Title").fill("Before edit");
  await page.getByLabel("Slug").fill("crud-browser");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit crud-browser" }).first().click();
  await page.getByLabel("Title").fill("After edit");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("After edit").first()).toBeVisible();
  await page.getByRole("button", { name: "Revoke crud-browser" }).first().click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Restore crud-browser" }).first().click();
  await expect(page.getByRole("button", { name: "Revoke crud-browser" }).first()).toBeVisible();
  const preview = await page.request.get("/crud-browser+");
  expect(preview.status()).toBe(200);
  await page.getByRole("button", { name: "Delete crud-browser" }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("After edit").first()).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Main page redirect").fill("https://example.org/");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved site settings.")).toBeVisible();
});

test("pending creation freezes the form and permits retry after failure", async ({ page }) => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await blocked;
    await route.fulfill({ status: 503, json: { error: "Please retry" } });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByRole("button", { name: "Create link" }).click();
  for (const name of ["Destination", "Title", "Slug", "Expires"]) await expect(page.getByLabel(name)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.screenshot({ path: "verification-artifacts/admin-pending.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "New link" })).toBeVisible();
  release?.();
  await expect(page.getByRole("alert")).toContainText("Please retry");
  await page.screenshot({ path: "verification-artifacts/admin-error.png", fullPage: true });
  await expect(page.getByLabel("Destination")).toBeEnabled();
});

test("visible links expire without interaction", async ({ page }) => {
  const deadline = new Date(Date.now() + 4000).toISOString();
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { links: [{ slug: "expiring", title: "Expiring soon", destination: "https://example.org/", status: "active", expiresAt: deadline, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], nextCursor: null } });
  });
  await page.goto("/admin");
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Expired", { exact: true }).first()).toBeVisible({ timeout: 8000 });
});

for (const status of [200, 500, 401]) {
  test(`superseded search ignores stale ${status} responses`, async ({ page }) => {
    let release: (() => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    await page.route("**/api/links?*", async (route) => {
      const search = new URL(route.request().url()).searchParams.get("search");
      if (search === "old") {
        requestStarted?.();
        await blocked;
        await route.fulfill({ status, json: status === 200 ? { links: [], nextCursor: null } : { error: "Old failure" } }).catch(() => undefined);
        return;
      }
      if (search === "new") {
        await route.fulfill({ json: { links: [{ slug: "current", title: "Current result", destination: "https://example.org/", status: "active", expiresAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], nextCursor: null } });
        return;
      }
      await route.continue();
    });
    await page.goto("/admin");
    await page.getByLabel("Search links").fill("old");
    await started;
    await page.getByLabel("Search links").fill("new");
    await expect(page.getByText("Current result").first()).toBeVisible();
    release?.();
    await expect(page.getByText("Current result").first()).toBeVisible();
    await expect(page.getByText("Old failure")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New link" })).toBeVisible();
  });
}

test("a delayed page renders already expired links correctly", async ({ page }) => {
  await page.clock.install();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  let release: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    notifyStarted?.();
    await blocked;
    await route.fulfill({ json: { links: [{ slug: "late", title: "Late result", destination: "https://example.org/", status: "active", expiresAt: deadline, createdAt: deadline, updatedAt: deadline }], nextCursor: null } }).catch(() => undefined);
  });
  await page.goto("/admin");
  await started;
  await page.clock.fastForward(120_000);
  release?.();
  await expect(page.getByText("Late result").first()).toBeVisible();
  await expect(page.getByText("Expired", { exact: true }).first()).toBeVisible({ timeout: 1000 });
});

test("independent settings edits preserve fields from another session", async ({ browser }) => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await Promise.all([first.goto("http://127.0.0.1:5174/admin"), second.goto("http://127.0.0.1:5174/admin")]);
  await first.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("button", { name: "Settings" }).click();
  await first.getByLabel("Main page redirect").fill("https://example.net/");
  await first.getByRole("button", { name: "Save changes" }).click();
  await expect(first.getByText("Saved site settings.")).toBeVisible();
  await second.getByLabel("Display name").fill("Independent name");
  await second.getByRole("button", { name: "Save changes" }).click();
  await expect(second.getByText("Saved site settings.")).toBeVisible({ timeout: 15000 });
  const session: unknown = await (await second.request.get("http://127.0.0.1:5174/api/session")).json();
  expect(session).toMatchObject({ displayName: "Independent name", homeRedirectUrl: "https://example.net/" });
  await first.close();
  await second.close();
});

test("mutation invalidation removes the old pagination cursor before reload", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Slug").fill("cursor-browser");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Edit cursor-browser" }).first()).toBeVisible();
  const response: unknown = await (await page.request.get("/api/links")).json();
  let mutated = false;
  let paginationCount = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/links**", async (route) => {
    if (route.request().method() === "PATCH") { mutated = true; return route.continue(); }
    if (route.request().method() !== "GET") return route.continue();
    if (new URL(route.request().url()).searchParams.has("cursor")) paginationCount += 1;
    if (!mutated) {
      if (typeof response !== "object" || response === null || !("links" in response)) throw new Error("Missing links");
      await route.fulfill({ json: { links: response.links, nextCursor: "stale-cursor" } });
      return;
    }
    await blocked;
    await route.continue().catch(() => undefined);
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await page.getByRole("button", { name: "Edit cursor-browser" }).first().click();
  await page.getByLabel("Title").fill("Cursor changed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Loading links…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(paginationCount).toBe(0);
  release?.();
  await expect(page.getByText("Cursor changed").first()).toBeVisible();
});

test("creation during initial load refreshes the list", async ({ page }) => {
  let created = false;
  let release: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  await page.route("**/api/links", async (route) => {
    if (route.request().method() === "POST") { created = true; return route.continue(); }
    if (route.request().method() !== "GET" || created) return route.continue();
    notifyStarted?.();
    await blocked;
    await route.fulfill({ json: { links: [], nextCursor: null } }).catch(() => undefined);
  });
  await page.goto("/admin");
  await started;
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Title").fill("Created while loading");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  release?.();
  await expect(page.getByText("Created while loading").first()).toBeVisible();
});

test("editing a searched title removes it from the current result", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Slug").fill("search-edit-browser");
  await page.getByLabel("Title").fill("Unique search phrase");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Search links").fill("Unique search phrase");
  await expect(page.getByRole("button", { name: "Edit search-edit-browser" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit search-edit-browser" }).first().click();
  await page.getByLabel("Title").fill("Changed title");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit search-edit-browser" })).toHaveCount(0);
});

test("pending edit freezes inputs, clear and dismissal until failure", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Slug").fill("pending-edit-browser");
  const expiry = await page.evaluate(() => {
    const future = new Date(Date.now() + 86_400_000);
    return new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  await page.getByLabel("Expires").fill(expiry);
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit pending-edit-browser" }).first().click();
  await page.getByLabel("Title").fill("Pending edit");
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/links/pending-edit-browser", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await blocked;
    await route.fulfill({ status: 503, json: { error: "Edit failed" } });
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  for (const name of ["Destination", "Title", "Expires"]) await expect(page.getByLabel(name)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit link" })).toBeVisible();
  release?.();
  await expect(page.getByRole("alert")).toContainText("Edit failed");
  await expect(page.getByLabel("Title")).toBeEnabled();
  await expect(page.getByLabel("Title")).toHaveValue("Pending edit");
});

test("a mutation completing after a query change refreshes the current search", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.org/");
  await page.getByLabel("Slug").fill("late-mutation-browser");
  await page.getByLabel("Title").fill("Old query result");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Link created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Revoke late-mutation-browser" }).first().click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore late-mutation-browser" }).first()).toBeVisible();
  let release: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  await page.route("**/api/links/late-mutation-browser", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    notifyStarted?.();
    await blocked;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Restore late-mutation-browser" }).first().click();
  await started;
  await page.getByLabel("Search links").fill("no matching result");
  await expect(page.getByRole("button", { name: "Restore late-mutation-browser" })).toHaveCount(0);
  release?.();
  await expect(page.getByText("Restored 127.0.0.1:5174/late-mutation-browser.")).toBeVisible();
  await expect(page.getByText("Old query result")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New link" })).toBeVisible();
});


test("revoked links update their expiry text at the deadline", async ({ page }) => {
  await page.clock.install();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { links: [{ slug: "revoked-expiring", title: "Revoked expiry", destination: "https://example.org/", status: "revoked", expiresAt: deadline, createdAt: deadline, updatedAt: deadline }], nextCursor: null } });
  });
  await page.goto("/admin");
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Expired", { exact: false }).first()).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect(page.getByText("Expired", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();
});
