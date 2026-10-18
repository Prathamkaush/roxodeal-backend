import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
const fixtures = JSON.parse(
  await readFile(".npm-cache/live-fixtures.json", "utf8"),
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const errors = [];
await mkdir(".npm-cache/live-browser", { recursive: true });
async function login(role, port) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://localhost:${port}/login`, {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Email", { exact: true }).fill(fixtures[role].email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(fixtures[role].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**/${role}/dashboard`);
  await page.locator(".ms-panel-content h1").waitFor();
  return page;
}
try {
  const buyer = await login("buyer", 3210);
  const admin = await login("admin", 3212);
  const seller = await login("seller", 3211);
  await buyer.goto("http://localhost:3210/buyer/requirements/create");
  await buyer
    .getByLabel("What are you looking for?")
    .fill("Browser corporate uniforms " + Date.now());
  const title = await buyer
    .getByLabel("What are you looking for?")
    .inputValue();
  await buyer
    .getByLabel("Category", { exact: true })
    .selectOption("Raw Textiles");
  await buyer.getByLabel("Quantity", { exact: true }).fill("300");
  await buyer.getByLabel("Approximate budget").fill("36000");
  await buyer.getByLabel("Delivery city").fill("Pune");
  await buyer.getByLabel("Required by").fill("2027-02-15");
  await buyer
    .getByLabel("Requirement details")
    .fill("Cotton uniforms with embroidered company branding");
  await buyer.getByRole("button", { name: /Post requirement/ }).click();
  await buyer.waitForURL(/\/buyer\/requirements\/[a-f0-9-]{36}$/);
  await buyer.getByRole("heading", { name: title }).waitFor();
  await buyer.reload();
  await buyer.getByRole("heading", { name: title }).waitFor();
  console.log(
    "PASS browser: authenticated buyer creates a persistent requirement",
  );
  await admin.goto("http://localhost:3212/admin/leads");
  const lead = admin
    .locator(".ms-lead-card")
    .filter({ has: admin.getByRole("heading", { name: title }) });
  await lead.waitFor();
  await lead.locator("select:not([name])").selectOption("Active");
  await admin
    .getByRole("status")
    .filter({ hasText: "Changes saved" })
    .waitFor();
  await seller.goto("http://localhost:3211/seller/leads");
  const supplierLead = seller
    .locator(".ms-lead-card")
    .filter({ has: seller.getByRole("heading", { name: title }) });
  await supplierLead.waitFor();
  assert.equal(
    await supplierLead.getByText(fixtures.buyer.email, { exact: true }).count(),
    0,
  );
  await supplierLead
    .getByRole("button", { name: "Unlock buyer contact" })
    .click();
  await supplierLead
    .getByRole("link", { name: fixtures.buyer.email })
    .waitFor();
  console.log(
    "PASS browser: admin approval, supplier visibility, private contact and credit unlock",
  );
  await seller.goto("http://localhost:3211/seller/products/create");
  await seller
    .getByLabel("Product name", { exact: true })
    .fill("Browser uploaded uniform");
  await seller.getByLabel(/^Price per unit/).fill("120");
  await seller.getByLabel("Minimum order quantity").fill("50");
  await seller
    .getByLabel("Description", { exact: true })
    .fill("Manufactured cotton uniforms with custom corporate logos");
  await seller
    .locator("input[type=file]")
    .setInputFiles("users/public/images/factory-hall.png");
  await seller
    .getByRole("status")
    .filter({ hasText: "Product images uploaded" })
    .waitFor();
  await seller.getByRole("button", { name: "Publish product" }).click();
  await seller.waitForURL("**/seller/products");
  await seller.getByText("Browser uploaded uniform", { exact: true }).waitFor();
  console.log(
    "PASS browser: local filesystem image upload, Sharp processing and product publication",
  );
  await buyer.goto("http://localhost:3210/products");
  await buyer
    .getByRole("heading", { name: "Browser uploaded uniform" })
    .waitFor();
  await buyer
    .locator('img[alt="Browser uploaded uniform"]')
    .evaluate((image) => image.decode());
  await admin.goto("http://localhost:3212/admin/subscriptions");
  await admin.getByRole("heading", { name: "Subscription plans" }).waitFor();
  const free = admin
    .locator("form")
    .filter({ has: admin.getByRole("heading", { name: "Free", exact: true }) });
  await free.locator("input[name=listings]").fill("6");
  await free.getByRole("button", { name: "Save plan" }).click();
  await admin
    .getByRole("status")
    .filter({ hasText: "Changes saved" })
    .waitFor();
  await buyer.setViewportSize({ width: 390, height: 844 });
  await buyer.goto("http://localhost:3210/buyer/dashboard");
  await buyer.locator(".ms-panel-content h1").waitFor();
  await buyer.getByRole("button", { name: "Open navigation" }).click();
  await buyer.waitForFunction(
    () =>
      document.querySelector(".ms-sidebar").getBoundingClientRect().left >= -1,
  );
  await buyer.screenshot({ path: ".npm-cache/live-browser/buyer-mobile.png" });
  await admin.screenshot({ path: ".npm-cache/live-browser/admin-live.png" });
  await seller.screenshot({ path: ".npm-cache/live-browser/seller-live.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser: public catalogue sync, admin plan persistence and authenticated mobile navigation",
  );
} finally {
  await browser.close();
}
