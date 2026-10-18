import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";

const fixtures = JSON.parse(await readFile(".npm-cache/live-fixtures.json", "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const base = process.env.ADMIN_URL || "http://localhost:3002";
const api = "http://localhost:4100/api";
const errors = [];
let reviews = 0, failNext = false, detailRequests = 0;
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/**", async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (request.method() === "GET" && /^\/api\/admin\/kyc\/.+/.test(path)) detailRequests++;
  if (path === "/api/workspace/actions" && request.postDataJSON()?.action === "SELLER_REVIEW") {
    reviews++;
    if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { message: "Review unavailable. Please retry." } }); }
  }
  const response = await route.fetch({ url: api + path.slice(4) + url.search });
  await route.fulfill({ response });
});
try {
  await page.goto(base + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(fixtures.admin.email);
  await page.getByLabel("Password", { exact: true }).fill(fixtures.admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/admin/dashboard");
  await page.goto(base + "/admin/kyc", { waitUntil: "networkidle" });
  await page.locator(".kyc-admin-row").first().waitFor();
  assert.equal(await page.locator(".kyc-admin-review").count(), 0);
  assert.equal(await page.locator("textarea").count(), 0);
  assert.equal(detailRequests, 0, "Private details load only after View");
  await mkdir(".npm-cache/kyc-review", { recursive: true });
  await page.screenshot({ path: ".npm-cache/kyc-review/admin-list-desktop.png", fullPage: true });
  const company = await page.locator(".kyc-admin-row").first().locator("strong").innerText();
  const view = () => page.getByRole("button", { name: "View KYC for " + company, exact: true });
  await view().click();
  const card = page.locator(".kyc-admin-review").filter({ has: page.getByRole("heading", { name: company, exact: true }) });
  const decision = card.getByRole("combobox");
  const message = card.getByLabel(/^Message to seller/);
  await decision.selectOption("Rejected");
  assert.equal(reviews, 0, "Selecting a decision must not save it");
  await message.fill("   ");
  await card.getByRole("button", { name: "Reject and notify seller" }).click();
  await card.getByRole("alert").filter({ hasText: "at least 10 characters" }).waitFor();
  assert.equal(reviews, 0, "Whitespace reason must not reach the API");
  const reason = "The PAN document is unreadable. Please upload a clear copy.";
  await message.fill(reason);
  failNext = true;
  await card.getByRole("button", { name: "Reject and notify seller" }).click();
  await card.getByRole("alert").filter({ hasText: "Review unavailable" }).waitFor();
  assert.equal(await message.inputValue(), reason, "Failed save preserves the message");
  await card.getByRole("button", { name: "Reject and notify seller" }).click();
  await card.getByRole("status").filter({ hasText: "Review saved" }).waitFor();
  await card.locator(".kyc-admin-note").getByText(reason, { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator(".kyc-admin-review").count(), 0);
  await view().click();
  await card.waitFor();
  assert.equal(await decision.inputValue(), "Rejected");
  await card.locator(".kyc-admin-note").getByText(reason, { exact: true }).waitFor();
  await decision.selectOption("Additional Documents Required");
  await message.fill("Please upload your business address proof with the company name visible.");
  await card.getByRole("button", { name: "Request documents and notify seller" }).click();
  await card.getByRole("status").filter({ hasText: "Review saved" }).waitFor();
  await mkdir(".npm-cache/kyc-review", { recursive: true });
  await page.screenshot({ path: ".npm-cache/kyc-review/admin-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".ms-sidebar");
    return !sidebar || sidebar.getBoundingClientRect().right <= 1;
  });
  await page.screenshot({ path: ".npm-cache/kyc-review/admin-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Back to sellers" }).click();
  await page.locator(".kyc-admin-row").first().waitFor();
  assert.equal(await page.locator("textarea").count(), 0);
  assert.ok(await page.getByText("Additional Documents Required", { exact: true }).count() > 0);
  await page.screenshot({ path: ".npm-cache/kyc-review/admin-list-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS browser: compact KYC list, on-demand details, explicit saves, validation, retries and mobile layout");
} finally { await browser.close(); }
