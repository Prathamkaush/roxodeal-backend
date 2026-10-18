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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = process.env.SELLER_URL || "http://localhost:3211";
await mkdir(".npm-cache/kyc-review", { recursive: true });
try {
  await page.goto(base + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(fixtures.seller.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(fixtures.seller.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/seller/dashboard");
  await page.goto(base + "/seller/kyc", { waitUntil: "networkidle" });
  const submit = page.getByRole("button", {
    name: "Submit business for review",
    exact: true,
  });
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole("heading", { name: "Prepare your documents" }).waitFor();
  await page.getByText("PAN card", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Private documents", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("evidence.pdf", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: ".npm-cache/kyc-review/desktop-before.png",
    fullPage: true,
  });
  const input = page.getByLabel("Choose verification documents");
  await input.setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a supported document"),
  });
  await page.getByRole("alert").filter({ hasText: "choose a PDF" }).waitFor();
  await input.setInputFiles({
    name: "business-registration.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nIsolated KYC browser fixture"),
  });
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole("button", { name: "Upload selected files" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "1 document uploaded" })
    .waitFor();
  assert.equal(await submit.isEnabled(), true);
  await page
    .getByRole("list")
    .filter({
      has: page.getByText("business-registration.pdf", { exact: true }),
    })
    .waitFor();
  const failedSubmission = async (route) => {
    if (route.request().postDataJSON()?.action === "KYC_SUBMIT")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          message: "Review service unavailable. Please retry.",
        }),
      });
    await route.continue();
  };
  await page.route("**/api/workspace/actions", failedSubmission);
  await submit.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Review service unavailable" })
    .waitFor();
  assert.equal(await submit.isEnabled(), true);
  await page.unroute("**/api/workspace/actions", failedSubmission);
  await submit.click();
  await page
    .getByRole("status")
    .filter({ hasText: "submitted successfully" })
    .waitFor();
  await page
    .getByRole("region", { name: "Verification status" })
    .getByRole("heading", { name: "Submitted", exact: true })
    .waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("region", { name: "Verification status" })
    .getByRole("heading", { name: "Submitted", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Submit business for review", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: ".npm-cache/kyc-review/desktop-submitted.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      document.querySelector(".ms-sidebar").getBoundingClientRect().right <= 1,
  );
  await page.screenshot({
    path: ".npm-cache/kyc-review/mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Mobile page must not overflow horizontally",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: KYC guidance, file validation, upload-before-submit gating, inline error/retry, persistent submission and mobile layout",
  );
} finally {
  await browser.close();
}
