import { chromium } from "playwright-core";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const fixtures = JSON.parse(await readFile(".npm-cache/live-fixtures.json", "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errors = [];
const origins = { buyer: process.env.USERS_URL || "http://localhost:3000", seller: process.env.SELLER_URL || "http://localhost:3001", admin: process.env.ADMIN_URL || "http://localhost:3002" };
const api = "http://localhost:4100/api";
let verifyAttempts = [], checkoutPayment;
async function login(role) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (role === "seller" && url.pathname === "/api/payments/orders" && request.method() === "POST") {
      return route.fulfill({ json: { orderId: checkoutPayment.gatewayOrderId, keyId: "rzp_test_mock", amount: checkoutPayment.amount, currency: "INR" } });
    }
    if (role === "seller" && url.pathname === "/api/payments/verify") {
      verifyAttempts.push(request.postDataJSON());
      return route.fulfill({ status: 503, json: { message: "Temporary verification failure" } });
    }
    const response = await route.fetch({ url: api + url.pathname.slice(4) + url.search });
    await route.fulfill({ response });
  });
  await page.goto(origins[role] + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(fixtures[role].email);
  await page.getByLabel("Password", { exact: true }).fill(fixtures[role].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/" + role + "/dashboard");
  return page;
}
try {
  const buyer = await login("buyer");
  await buyer.goto(origins.buyer + "/", { waitUntil: "networkidle" });
  assert.equal(await buyer.getByRole("link", { name: "Login / Register", exact: true }).count(), 0);
  await buyer.locator(".rx-header .rx-login[href='/buyer/dashboard']").waitFor();
  await buyer.reload({ waitUntil: "networkidle" });
  await buyer.locator(".rx-header .rx-login[href='/buyer/dashboard']").waitFor();
  console.log("PASS browser: homepage retains buyer session after navigation and reload");
  const seller = await login("seller");
  const admin = await login("admin");
  await buyer.goto(origins.buyer + "/buyer/requirements/create", { waitUntil: "networkidle" });
  const title = "Buyer approved flow " + Date.now();
  await buyer.getByLabel("What are you looking for?").fill(title);
  await buyer.getByLabel("Category", { exact: true }).selectOption("Raw Textiles");
  await buyer.getByLabel("Quantity", { exact: true }).fill("500");
  await buyer.getByLabel("Approximate budget").fill("50000");
  await buyer.getByLabel("Delivery city").fill("Delhi");
  await buyer.getByLabel("Required by").fill("2027-02-15");
  await buyer.getByLabel("Requirement details").fill("Cotton fabric for business uniforms with standard quality specifications");
  await buyer.getByRole("button", { name: /Post requirement/ }).click();
  await buyer.waitForURL(/\/buyer\/requirements\/[a-f0-9-]{36}$/);
  await seller.goto(origins.seller + "/seller/leads", { waitUntil: "networkidle" });
  assert.equal(await seller.getByRole("heading", { name: title }).count(), 0);
  await admin.goto(origins.admin + "/admin/leads", { waitUntil: "networkidle" });
  const lead = admin.locator(".ms-lead-card").filter({ has: admin.getByRole("heading", { name: title }) });
  await lead.locator("select:not([name])").selectOption("Active");
  await admin.getByRole("status").filter({ hasText: "Changes saved" }).waitFor();
  await seller.getByRole("button", { name: "Refresh leads" }).click();
  await seller.getByRole("heading", { name: title }).waitFor();
  console.log("PASS browser: buyer posts lead, admin approves it and seller sees the approved requirement");
  const tokens = await seller.evaluate(() => JSON.parse(sessionStorage.getItem("roxodeal-session")));
  const workspace = await (await fetch(api + "/workspace", { headers: { Authorization: "Bearer " + tokens.accessToken } })).json();
  checkoutPayment = workspace.payments.find(payment => payment.type === "SUBSCRIPTION" && payment.status === "CAPTURED");
  assert.ok(checkoutPayment);
  await seller.addInitScript(({payment}) => {
    window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() { this.options.handler({ razorpay_order_id: payment.gatewayOrderId, razorpay_payment_id: payment.gatewayPaymentId, razorpay_signature: "a".repeat(64) }); }
    };
  }, { payment: checkoutPayment });
  await seller.goto(origins.seller + "/seller/subscriptions", { waitUntil: "networkidle" });
  await seller.getByRole("button", { name: "Choose Silver", exact: true }).click();
  await seller.getByRole("alert").filter({ hasText: "Temporary verification failure" }).waitFor();
  assert.equal(verifyAttempts.length, 1);
  assert.equal(verifyAttempts[0].paymentId, checkoutPayment.gatewayPaymentId);
  assert.equal(verifyAttempts[0].orderId, checkoutPayment.gatewayOrderId);
  assert.equal(await seller.getByRole("button", { name: "Choose Silver", exact: true }).isDisabled(), true);
  await seller.reload({ waitUntil: "networkidle" });
  await seller.getByRole("button", { name: "Check payment status", exact: true }).click();
  await seller.getByRole("status").filter({ hasText: "plan and lead credits are now active" }).first().waitFor();
  await seller.goto(origins.seller + "/seller/dashboard", { waitUntil: "networkidle" });
  await seller.locator(".ms-plan-title").getByRole("heading", { name: "Silver", exact: true }).waitFor();
  await admin.goto(origins.admin + "/admin/payments", { waitUntil: "networkidle" });
  const paymentRow = admin.getByRole("row").filter({ hasText: checkoutPayment.gatewayPaymentId });
  await paymentRow.waitFor();
  assert.match(await paymentRow.innerText(), /Factory 0/);
  assert.match(await paymentRow.innerText(), /Silver/);
  assert.match(await paymentRow.innerText(), /CAPTURED/);
  await mkdir(".npm-cache/live-browser", { recursive: true });
  await admin.screenshot({ path: ".npm-cache/live-browser/admin-subscription-payments.png", fullPage: true });
  console.log("PASS browser: signed callback submission, reload-safe payment retry, current plan and admin purchaser details");
  await buyer.goto(origins.buyer + "/", { waitUntil: "networkidle" });
  await buyer.getByRole("button", { name: "Sign out", exact: true }).click();
  await buyer.getByRole("link", { name: "Login / Register", exact: true }).waitFor();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
