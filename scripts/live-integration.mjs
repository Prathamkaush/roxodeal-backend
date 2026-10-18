import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as smtpServer } from "node:net";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url),
  { parse } = require("dotenv"),
  { PrismaClient } = require("@prisma/client"),
  { hash } = require("argon2");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = parse(await readFile(path.join(root, ".env.docker")));
const database = "roxodeal_test_" + Date.now();
const sql = spawnSync(
  "docker",
  [
    "exec",
    process.env.POSTGRES_CONTAINER || "mandisetu-postgres-1",
    "psql",
    "-U",
    cfg.POSTGRES_USER || "mandisetu",
    "-d",
    cfg.POSTGRES_DB || "mandisetu",
    "-c",
    `CREATE DATABASE ${database}`,
  ],
  { encoding: "utf8" },
);
assert.equal(sql.status, 0, "Create isolated integration database");
const DATABASE_URL = `postgresql://${cfg.POSTGRES_USER || "mandisetu"}:${cfg.POSTGRES_PASSWORD}@127.0.0.1:${cfg.POSTGRES_PORT || 15432}/${database}`;
const REDIS_URL = `redis://:${cfg.REDIS_PASSWORD}@127.0.0.1:${cfg.REDIS_PORT || 16379}/0`;
const env = {
  ...process.env,
  DATABASE_URL,
  REDIS_URL,
  JWT_SECRET: cfg.JWT_SECRET,
  NODE_ENV: "test",
  AUTH_RATE_NAMESPACE: database,
  PORT: "4100",
  WEB_ORIGINS:
    "http://localhost:3210,http://localhost:3211,http://localhost:3212",
  PRIVATE_UPLOAD_DIR: path.join(root, "uploads/integration-private"),
  PUBLIC_UPLOAD_DIR: path.join(root, "uploads/integration-public"),
  PUBLIC_FILE_BASE_URL: "http://localhost:4100/api/files/public",
  RAZORPAY_WEBHOOK_SECRET: randomUUID(),
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "noreply@roxodeal.test",
};
const migration = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"],
  { cwd: root, env, encoding: "utf8" },
);
assert.equal(migration.status, 0, migration.stderr);
console.log(
  "PASS: additive migrations applied to isolated PostgreSQL database",
);
const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
async function invalidateFixtureCache() {
  const redis = require("redis").createClient({ url: REDIS_URL });
  await redis.connect();
  try {
    const namespace = createHash("sha256")
      .update(DATABASE_URL)
      .digest("hex")
      .slice(0, 16);
    await redis.set(
      "roxodeal:cache:" + namespace + ":generation",
      randomUUID(),
      { EX: 120 },
    );
  } finally {
    await redis.close();
  }
}

let smsCalls = 0,
  mail = "";
const sms = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  smsCalls++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => sms.listen(0, "127.0.0.1", resolve));
// Active authentication must work without any SMS provider configuration.
env.SMS_PROVIDER_URL = "";
env.SMS_PROVIDER_TOKEN = "";
const smtp = smtpServer((socket) => {
  socket.write("220 localhost\r\n");
  let data = false,
    buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const end = buffer.indexOf("\r\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data) {
        if (line === ".") {
          data = false;
          socket.write("250 received\r\n");
        } else mail += line + "\r\n";
      } else if (/^DATA/i.test(line)) {
        data = true;
        socket.write("354 send data\r\n");
      } else if (/^QUIT/i.test(line)) {
        socket.end("221 bye\r\n");
      } else socket.write("250 OK\r\n");
    }
  });
});
await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
env.SMTP_HOST = "127.0.0.1";
env.SMTP_PORT = String(smtp.address().port);
const gatewayPayments = new Map();
const gatewayOrders = new Map();
let gatewayCaptures = 0;
const gateway = createServer(async (req, res) => {
  let input = "";
  for await (const chunk of req) input += chunk;
  const data = input ? JSON.parse(input) : {};
  let output;
  if (req.url === "/orders" && req.method === "POST") {
    const id = "order_" + randomUUID().replaceAll("-", "");
    gatewayOrders.set(id, data);
    output = { id, amount: data.amount, currency: data.currency };
  } else if (req.url?.startsWith("/payments/")) {
    const id = req.url.split("/")[2];
    const entity = gatewayPayments.get(id);
    if (entity && req.method === "POST" && req.url.endsWith("/capture")) {
      assert.equal(data.amount, entity.amount);
      assert.equal(data.currency, "INR");
      entity.status = "captured";
      gatewayCaptures++;
    }
    output = entity;
  } else if (req.url?.startsWith("/orders/") && req.url.endsWith("/payments")) {
    const orderId = req.url.split("/")[2];
    output = {
      items: [...gatewayPayments.values()].filter(
        (entity) => entity.order_id === orderId,
      ),
    };
  }
  res.writeHead(output ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(output || { error: "Unknown test gateway entity" }));
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
env.RAZORPAY_TEST_API_URL = "http://127.0.0.1:" + gateway.address().port;
env.RAZORPAY_KEY_ID = "rzp_test_isolated";
env.RAZORPAY_KEY_SECRET = randomUUID();
const api = spawn(process.execPath, ["dist/main.js"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
api.stdout.on("data", (c) => (logs += c));
api.stderr.on("data", (c) => (logs += c));
const base = "http://127.0.0.1:4100/api";
const password = "Integration-" + randomUUID();
async function request(
  route,
  token,
  body,
  expected = 200,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, expected, route + " " + JSON.stringify(result));
  return result;
}
const mutate = (token, action, id, data) =>
  request("/workspace/actions", token, { action, id, data }, 201);
let fixtures;
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const r = await fetch(base + "/health/ready", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (api.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    await writeFile(
      path.resolve(root, "../.npm-cache/integration-startup.log"),
      logs
        .replaceAll(cfg.POSTGRES_PASSWORD, "[redacted]")
        .replaceAll(cfg.REDIS_PASSWORD, "[redacted]")
        .replaceAll(cfg.JWT_SECRET, "[redacted]"),
    );
    throw new Error(
      "Integration API startup failed; inspect .npm-cache/integration-startup.log",
    );
  }
  const free = await db.plan.create({
    data: { name: "Free", price: 0, listingLimit: 5, leadCredits: 0 },
  });
  const silver = await db.plan.create({
    data: { name: "Silver", price: 10000, listingLimit: 40, leadCredits: 15 },
  });
  const category = await db.category.create({
    data: { name: "Raw Textiles", leadPrice: 19900 },
  });
  await db.cmsPage.create({
    data: { slug: "about", title: "About", content: "Roxodeal live catalogue" },
  });
  const suffix = Date.now();
  const buyerEmail = `buyer-${suffix}@example.com`,
    phone = `9${String(suffix).slice(-9)}`;
  const registered = await request(
    "/auth/register",
    null,
    {
      name: "Integration Buyer",
      email: buyerEmail,
      phone,
      password,
      role: "BUYER",
    },
    201,
  );
  await request("/auth/login", null, { email: buyerEmail, password }, 401);
  const duplicateEmail = await request(
    "/auth/register",
    null,
    {
      name: "Another Buyer",
      email: buyerEmail,
      phone: `5${String(suffix).slice(-9)}`,
      password,
      role: "BUYER",
    },
    400,
  );
  assert.match(duplicateEmail.message, /email address is already registered/);
  const duplicatePhone = await request(
    "/auth/register",
    null,
    {
      name: "Another Buyer",
      email: `other-${suffix}@example.com`,
      phone,
      password,
      role: "BUYER",
    },
    400,
  );
  assert.match(duplicatePhone.message, /mobile number is already registered/);
  await request(
    "/auth/register",
    null,
    {
      name: "  ",
      email: `invalid-name-${suffix}@example.com`,
      phone: `6${String(suffix).slice(-9)}`,
      password,
      role: "BUYER",
    },
    400,
  );
  await request(
    "/auth/register",
    null,
    {
      name: "Valid Name",
      email: `invalid-phone-${suffix}@example.com`,
      phone: "91abc123",
      password,
      role: "BUYER",
    },
    400,
  );
  await request("/auth/login", null, { email: "not-an-email", password }, 400);
  await request("/auth/login", null, { email: buyerEmail, password: "" }, 400);
  await request("/auth/email/send", null, { email: buyerEmail }, 201);
  const emailCode = mail.match(/verification code is (\d{6})/)?.[1];
  assert.ok(emailCode, "Verification code delivered through SMTP");
  const resendResponse = await fetch(base + "/auth/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: buyerEmail }),
  });
  assert.equal(resendResponse.status, 429);
  assert.ok(Number(resendResponse.headers.get("Retry-After")) > 0);
  const rateClient = require("redis").createClient({ url: REDIS_URL });
  await rateClient.connect();
  try {
    const key =
      "roxodeal:email-send:" +
      database +
      ":verification:" +
      createHash("sha256").update(buyerEmail.toLowerCase()).digest("hex");
    await rateClient.set(key + ":hour", "5", { EX: 3600 });
    await rateClient.del(key + ":cooldown");
    const hourly = await request(
      "/auth/email/send",
      null,
      { email: buyerEmail },
      429,
    );
    assert.ok(hourly.retryAfter > 60);
    assert.equal(
      await db.emailVerificationChallenge.count({
        where: { email: buyerEmail },
      }),
      1,
    );
  } finally {
    await rateClient.close();
  }
  await request(
    "/auth/email/verify",
    null,
    { email: buyerEmail, code: "000000" },
    400,
  );
  await request(
    "/auth/email/verify",
    null,
    { email: buyerEmail, code: emailCode },
    201,
  );
  await request(
    "/auth/email/verify",
    null,
    { email: buyerEmail, code: emailCode },
    400,
  );
  assert.equal(
    (await db.user.findUnique({ where: { id: registered.id } })).phoneVerified,
    false,
  );
  await request("/auth/otp/send", null, { phone }, 404);
  await request("/auth/otp/verify", null, { phone, code: "000000" }, 404);
  assert.equal(
    smsCalls,
    0,
    "Email authentication must not call an SMS provider",
  );
  const buyer = await request(
    "/auth/login",
    null,
    { email: buyerEmail, password },
    201,
  );
  console.log(
    "PASS: email verification, resend/attempt limits, disabled SMS routes and login without mobile OTP",
  );
  const adminUser = await db.user.create({
    data: {
      email: `admin-${suffix}@example.com`,
      phone: "8" + String(suffix).slice(-9),
      name: "Integration Admin",
      role: "ADMIN",
      phoneVerified: true,
      emailVerified: true,
      passwordHash: await hash(password),
    },
  });
  const admin = await request(
    "/auth/login",
    null,
    { email: adminUser.email, password },
    201,
  );
  const sellers = [];
  for (let i = 0; i < 6; i++) {
    const user = await db.user.create({
      data: {
        email: `supplier${i}-${suffix}@example.com`,
        phone: `7${String(suffix).slice(-8)}${i}`,
        name: "Supplier " + i,
        role: "SELLER",
        phoneVerified: true,
        emailVerified: true,
        passwordHash: await hash(password),
        seller: {
          create: {
            company: "Factory " + i,
            city: "Surat",
            state: "Gujarat",
            address: "Factory road",
            pincode: "395001",
            planId: silver.id,
            credits: 15,
            subscriptionExpiresAt: new Date(Date.now() + 86400000),
            categories: { create: { categoryId: category.id } },
          },
        },
      },
      include: { seller: true },
    });
    const token = await request(
      "/auth/login",
      null,
      { email: user.email, password },
      201,
    );
    sellers.push({ ...token, sellerId: user.seller.id, email: user.email });
  }
  const leadId = randomUUID();
  const subscriptionOrder = await request(
    "/payments/orders",
    sellers[0].accessToken,
    { type: "SUBSCRIPTION", targetId: silver.id },
    201,
  );
  const checkoutPaymentId = "pay_" + randomUUID().replaceAll("-", "");
  const checkoutEntity = {
    id: checkoutPaymentId,
    order_id: subscriptionOrder.orderId,
    amount: subscriptionOrder.amount,
    currency: "INR",
    status: "authorized",
  };
  gatewayPayments.set(checkoutPaymentId, checkoutEntity);
  const checkoutSignature = createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(subscriptionOrder.orderId + "|" + checkoutPaymentId)
    .digest("hex");
  const verificationBody = {
    orderId: subscriptionOrder.orderId,
    paymentId: checkoutPaymentId,
    signature: checkoutSignature,
  };
  await request(
    "/payments/verify",
    sellers[1].accessToken,
    verificationBody,
    403,
  );
  await request(
    "/payments/verify",
    sellers[0].accessToken,
    { ...verificationBody, signature: "0".repeat(64) },
    400,
  );
  const beforeVerify = await db.seller.findUniqueOrThrow({
    where: { id: sellers[0].sellerId },
  });
  checkoutEntity.amount++;
  await request(
    "/payments/verify",
    sellers[0].accessToken,
    verificationBody,
    400,
  );
  assert.equal(gatewayCaptures, 0);
  checkoutEntity.amount--;
  const verifiedPayment = await request(
    "/payments/verify",
    sellers[0].accessToken,
    verificationBody,
    201,
  );
  assert.equal(verifiedPayment.status, "CAPTURED");
  const activatedSeller = await db.seller.findUniqueOrThrow({
    where: { id: sellers[0].sellerId },
  });
  assert.equal(activatedSeller.planId, silver.id);
  assert.equal(activatedSeller.credits, silver.leadCredits);
  assert.ok(
    activatedSeller.subscriptionExpiresAt > beforeVerify.subscriptionExpiresAt,
  );
  assert.equal(gatewayCaptures, 1);
  const paymentPayload = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: checkoutEntity } },
  });
  const replayResponse = await fetch(base + "/payments/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
        .update(paymentPayload)
        .digest("hex"),
    },
    body: paymentPayload,
  });
  assert.equal(replayResponse.status, 201);
  await request(
    "/payments/verify",
    sellers[0].accessToken,
    verificationBody,
    201,
  );
  assert.equal(
    (
      await db.seller.findUniqueOrThrow({ where: { id: sellers[0].sellerId } })
    ).subscriptionExpiresAt.toISOString(),
    activatedSeller.subscriptionExpiresAt.toISOString(),
  );
  const adminPaymentNotices = (
    await request("/notifications", admin.accessToken)
  ).filter((n) => n.message.includes(checkoutPaymentId));
  assert.equal(adminPaymentNotices.length, 1);
  assert.ok(adminPaymentNotices[0].message.includes(silver.name));
  const historyPayment = (
    await request("/workspace", admin.accessToken)
  ).payments.find((p) => p.gatewayPaymentId === checkoutPaymentId);
  assert.equal(historyPayment.payerName, "Factory 0");
  assert.equal(historyPayment.planName, silver.name);
  const recoveryOrder = await request(
    "/payments/orders",
    sellers[1].accessToken,
    { type: "SUBSCRIPTION", targetId: silver.id },
    201,
  );
  const recoveredId = "pay_" + randomUUID().replaceAll("-", "");
  gatewayPayments.set(recoveredId, {
    id: recoveredId,
    order_id: recoveryOrder.orderId,
    amount: recoveryOrder.amount,
    currency: "INR",
    status: "captured",
  });
  await request(
    "/payments/orders/" + recoveryOrder.orderId + "/status",
    sellers[0].accessToken,
    undefined,
    403,
  );
  assert.equal(
    (
      await request(
        "/payments/orders/" + recoveryOrder.orderId + "/status",
        sellers[1].accessToken,
      )
    ).status,
    "CAPTURED",
  );
  console.log(
    "PASS: Razorpay checkout verification, automatic plan/credits, missed-webhook recovery and single admin notification",
  );
  await mutate(buyer.accessToken, "LEAD_CREATE", leadId, {
    title: "Cotton uniforms for corporate teams",
    category: "Raw Textiles",
    quantity: 500,
    unit: "pieces",
    budget: 100000,
    city: "Mumbai",
    description: "Corporate uniforms with embroidered logos",
    date: "2027-01-10",
  });
  assert.equal(
    (await request("/workspace", sellers[0].accessToken)).leads.some(
      (lead) => lead.id === leadId,
    ),
    false,
    "Unapproved leads remain hidden",
  );
  await mutate(admin.accessToken, "LEAD_REVIEW", leadId, {
    status: "Active",
    price: 0,
  });
  await db.sellerCategory.deleteMany({
    where: { sellerId: sellers[5].sellerId },
  });
  const categoryless = await request("/workspace", sellers[5].accessToken);
  const preview = categoryless.leads.find((lead) => lead.id === leadId);
  assert.ok(
    preview,
    "New sellers can preview approved leads before choosing a category",
  );
  assert.equal(preview.email, "");
  await request(
    "/leads/" + leadId + "/unlock",
    sellers[5].accessToken,
    {},
    409,
  );
  await mutate(sellers[5].accessToken, "PROFILE", undefined, {
    ...categoryless.sellers[0],
    category: "Raw Textiles",
  });
  const matched = await request("/workspace", sellers[5].accessToken);
  assert.equal(matched.sellers[0].category, "Raw Textiles");
  assert.ok(matched.leads.some((lead) => lead.id === leadId));
  const locked = await request("/workspace", sellers[0].accessToken);
  assert.equal(locked.leads[0].email, "");
  assert.equal(locked.leads[0].phone, "");
  await request("/admin/leads", buyer.accessToken, undefined, 403);
  await mutate(sellers[0].accessToken, "LEAD_REVIEW", leadId, {
    status: "Active",
    price: 0,
  })
    .then(() => assert.fail("Seller must not approve leads"))
    .catch((e) => assert.match(e.message, /403/));
  const concurrent = await Promise.all(
    sellers.map((s) =>
      fetch(base + "/leads/" + leadId + "/unlock", {
        method: "POST",
        headers: { Authorization: "Bearer " + s.accessToken },
      }),
    ),
  );
  assert.equal(concurrent.filter((r) => r.ok).length, 5);
  assert.equal(await db.leadPurchase.count({ where: { leadId } }), 5);
  const successful = concurrent.findIndex((r) => r.ok);
  const unlocked = await request("/workspace", sellers[successful].accessToken);
  assert.equal(unlocked.leads[0].email, buyerEmail);
  assert.equal((await request("/catalogue")).leads.length, 0);
  console.log(
    "PASS: cross-role lead flow, private contact redaction, role enforcement and concurrent five-slot limit",
  );
  const paidId = randomUUID();
  await mutate(buyer.accessToken, "LEAD_CREATE", paidId, {
    title: "Additional cotton order",
    category: "Raw Textiles",
    quantity: 100,
    unit: "pieces",
    budget: 50000,
    city: "Mumbai",
    description: "Additional uniforms with screen printing",
    date: "2027-01-20",
  });
  await mutate(admin.accessToken, "LEAD_REVIEW", paidId, {
    status: "Active",
    price: 199,
  });
  await request(
    "/leads/" + paidId + "/unlock",
    sellers[0].accessToken,
    {},
    201,
  );
  assert.equal(
    (await db.seller.findUnique({ where: { id: sellers[0].sellerId } }))
      .credits,
    14,
  );
  await request(
    "/leads/" + paidId + "/unlock",
    sellers[0].accessToken,
    {},
    409,
  );
  console.log("PASS: atomic credit deduction and duplicate unlock rejection");
  const productId = randomUUID();
  await mutate(sellers[0].accessToken, "PRODUCT_CREATE", productId, {
    name: "Cotton wholesale uniform",
    category: "Raw Textiles",
    price: 120.5,
    moq: 50,
    unit: "piece",
    image: "https://example.com/uniform.jpg",
    description: "Wholesale cotton uniforms for companies",
  });
  assert.equal(
    (await db.product.findUnique({ where: { id: productId } })).price,
    12050,
  );
  await mutate(buyer.accessToken, "SAVE_PRODUCT", productId, { saved: true });
  assert(
    (await request("/workspace", buyer.accessToken)).saved.includes(productId),
  );
  await mutate(buyer.accessToken, "ENQUIRY_CREATE", undefined, {
    sellerId: sellers[0].sellerId,
    productId,
    message: "Please quote for 500 uniforms",
  });
  const enquiries = (await request("/workspace", sellers[0].accessToken))
    .enquiries;
  assert.equal(enquiries[0].buyer.email, buyerEmail);
  await mutate(sellers[0].accessToken, "ENQUIRY_RESPONSE", enquiries[0].id, {
    response: "We can supply within two weeks",
  });
  console.log(
    "PASS: persistent products, integer paise, shortlist and buyer/seller enquiries",
  );
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.7\nfixture document"]), "invoice.pdf");
  const uploaded = await fetch(base + "/files/private", {
    method: "POST",
    headers: { Authorization: "Bearer " + buyer.accessToken },
    body: form,
  });
  assert.equal(uploaded.status, 201);
  const document = await uploaded.json();
  assert.equal(
    (
      await fetch(base + "/files/private/" + document.id, {
        headers: { Authorization: "Bearer " + sellers[0].accessToken },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/files/private/" + document.id, {
        headers: { Authorization: "Bearer " + admin.accessToken },
      })
    ).status,
    200,
  );
  console.log("PASS: private uploads and owner/admin download authorization");
  const kycSeller = sellers[2];
  await request(
    "/workspace/actions",
    kycSeller.accessToken,
    { action: "KYC_SUBMIT", data: {} },
    400,
  );
  await request(
    "/workspace/actions",
    buyer.accessToken,
    { action: "KYC_SUBMIT", data: {} },
    403,
  );
  const kycBody = new FormData();
  kycBody.append(
    "file",
    new Blob(["%PDF-1.4\nBusiness verification fixture"], {
      type: "application/pdf",
    }),
    "business-pan.pdf",
  );
  kycBody.append("purpose", "KYC");
  const kycUpload = await fetch(base + "/files/private", {
    method: "POST",
    headers: { Authorization: "Bearer " + kycSeller.accessToken },
    body: kycBody,
  });
  assert.equal(kycUpload.status, 201);
  await mutate(kycSeller.accessToken, "KYC_SUBMIT", undefined, {});
  assert.equal(
    (await db.seller.findUnique({ where: { id: kycSeller.sellerId } })).kyc,
    "SUBMITTED",
  );
  await request(
    "/workspace/actions",
    kycSeller.accessToken,
    { action: "KYC_SUBMIT", data: {} },
    400,
  );
  await mutate(admin.accessToken, "SELLER_REVIEW", kycSeller.sellerId, {
    kyc: "Approved",
    note: "Business documents reviewed",
  });
  await request(
    "/workspace/actions",
    kycSeller.accessToken,
    { action: "KYC_SUBMIT", data: {} },
    400,
  );
  assert.equal(
    (await db.seller.findUnique({ where: { id: kycSeller.sellerId } })).kyc,
    "APPROVED",
  );
  await mutate(admin.accessToken, "SELLER_REVIEW", kycSeller.sellerId, {
    kyc: "Additional Documents Required",
    note: "Please add business address proof",
  });
  assert.equal(
    (await request("/workspace", kycSeller.accessToken)).sellers[0].kycNote,
    "Please add business address proof",
  );
  assert.ok(
    (await request("/notifications", kycSeller.accessToken)).some((n) =>
      n.message.includes("Please add business address proof"),
    ),
  );
  for (const decision of ["Rejected", "Additional Documents Required"]) {
    for (const note of [undefined, "   ", "No"]) {
      await request(
        "/workspace/actions",
        admin.accessToken,
        {
          action: "SELLER_REVIEW",
          id: kycSeller.sellerId,
          data: { kyc: decision, note },
        },
        400,
      );
      assert.equal(
        (await db.seller.findUnique({ where: { id: kycSeller.sellerId } })).kyc,
        "ADDITIONAL_DOCUMENTS_REQUIRED",
      );
    }
    await request(
      "/admin/kyc/" + kycSeller.sellerId,
      admin.accessToken,
      {
        status: decision.toUpperCase().replaceAll(" ", "_"),
        note: "   ",
      },
      400,
      "PATCH",
    );
  }
  await request(
    "/admin/kyc/" + kycSeller.sellerId,
    admin.accessToken,
    {
      status: "REJECTED",
      note: "  The registration certificate is unreadable. Please upload a clear copy.  ",
    },
    200,
    "PATCH",
  );
  assert.equal(
    (await request("/workspace", kycSeller.accessToken)).sellers[0].kycNote,
    "The registration certificate is unreadable. Please upload a clear copy.",
  );
  assert.ok(
    (await request("/notifications", kycSeller.accessToken)).some((n) =>
      n.message.includes("registration certificate is unreadable"),
    ),
  );
  await mutate(kycSeller.accessToken, "KYC_SUBMIT", undefined, {});
  const kycSummary = await request("/admin/kyc?page=1", admin.accessToken);
  assert.equal(kycSummary.pageSize, 20);
  assert.ok(
    kycSummary.items.every(
      (item) =>
        Object.keys(item).sort().join(",") === "city,company,id,kyc,name",
    ),
  );
  const kycDetail = await request(
    "/admin/kyc/" + kycSeller.sellerId,
    admin.accessToken,
  );
  assert.ok(kycDetail.documents.length > 0);
  assert.ok(kycDetail.documents.every((doc) => doc.purpose === "KYC"));
  assert.equal(
    kycDetail.seller.kycNote,
    "The registration certificate is unreadable. Please upload a clear copy.",
  );
  assert.equal("passwordHash" in kycDetail.seller, false);
  const context = await request("/workspace?view=kyc", admin.accessToken);
  assert.equal(context.profile.email, adminUser.email);
  assert.equal("documents" in context, false);
  assert.equal("sellers" in context, false);
  for (const token of [buyer.accessToken, kycSeller.accessToken]) {
    await request("/admin/kyc", token, undefined, 403);
    await request("/admin/kyc/" + kycSeller.sellerId, token, undefined, 403);
    await request("/workspace?view=kyc", token, undefined, 403);
  }
  await request("/admin/kyc?page=0", admin.accessToken, undefined, 400);
  await request("/admin/kyc/missing-seller", admin.accessToken, undefined, 404);
  const paginationIds = Array.from({ length: 21 }, () => randomUUID());
  await db.user.createMany({
    data: paginationIds.map((id, index) => ({
      id,
      email: `kyc-page-${index}-${suffix}@example.com`,
      phone: `80088${String(index).padStart(5, "0")}`,
      name: `Pagination seller ${index}`,
      role: "SELLER",
      passwordHash: adminUser.passwordHash,
    })),
  });
  await db.seller.createMany({
    data: paginationIds.map((id, index) => ({
      id,
      userId: id,
      company: `Pagination factory ${index}`,
      city: "Delhi",
      state: "Delhi",
      address: "Test address",
      pincode: "110001",
    })),
  });
  await invalidateFixtureCache(); // Direct fixture writes intentionally bypass API invalidation.
  const firstKycPage = await request("/admin/kyc?page=1", admin.accessToken);
  const secondKycPage = await request("/admin/kyc?page=2", admin.accessToken);
  assert.equal(firstKycPage.items.length, 20);
  assert.equal(secondKycPage.items.length, firstKycPage.total - 20);
  assert.ok(
    secondKycPage.items.every(
      (item) => !firstKycPage.items.some((first) => first.id === item.id),
    ),
  );
  await db.seller.deleteMany({ where: { id: { in: paginationIds } } });
  await db.user.deleteMany({ where: { id: { in: paginationIds } } });
  console.log(
    "PASS: KYC messages, paginated summaries, on-demand private details and admin-only access",
  );
  await mutate(admin.accessToken, "PROTECTION_REVIEW", "fee", { fee: 499 });
  const protection = await mutate(
    buyer.accessToken,
    "PROTECTION_CREATE",
    undefined,
    {
      sellerId: sellers[0].sellerId,
      reference: "DEAL-" + suffix,
      product: "Cotton uniforms",
      quantity: 500,
      dealAmount: 100000,
      deliveryDate: "2027-01-10",
      terms: "Delivery of agreed specifications within two weeks",
    },
  );
  const payment = await db.payment.create({
    data: {
      userId: registered.id,
      type: "PROTECTION",
      targetId: protection.id,
      amount: 49900,
      gatewayOrderId: "order_" + suffix,
    },
  });
  const payload = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_" + suffix,
          order_id: payment.gatewayOrderId,
          amount: 49900,
          currency: "INR",
          status: "captured",
        },
      },
    },
  });
  const signature = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
  const webhook = () =>
    fetch(base + "/payments/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature,
      },
      body: payload,
    });
  assert.equal((await webhook()).status, 201);
  assert.equal((await webhook()).status, 201);
  assert.equal(
    (await db.protection.findUnique({ where: { id: protection.id } })).status,
    "ACTIVE",
  );
  await mutate(buyer.accessToken, "CLAIM_CREATE", randomUUID(), {
    protectionId: protection.id,
    title: "Delivery failure",
    amount: 100000,
    reason: "Supplier did not deliver the agreed goods",
  });
  const claim = await db.claim.findFirst({ where: { buyerId: registered.id } });
  await mutate(sellers[0].accessToken, "CLAIM_UPDATE", claim.id, {
    response: "We are providing shipping documents for review",
  });
  await mutate(admin.accessToken, "CLAIM_UPDATE", claim.id, {
    status: "Approved",
    approvedAmount: 100000,
    adminNote: "Evidence reviewed manually",
  });
  assert.equal(
    (await db.claim.findUnique({ where: { id: claim.id } })).approvedAmount,
    10000000,
  );
  console.log(
    "PASS: signed/idempotent payment webhook, protection activation and manual claim review",
  );
  const evidenceBody = new FormData();
  evidenceBody.append(
    "file",
    new Blob(["%PDF-1.4\nClaim evidence"], { type: "application/pdf" }),
    "evidence.pdf",
  );
  evidenceBody.append("purpose", "CLAIM");
  const evidenceResponse = await fetch(base + "/files/private", {
    method: "POST",
    headers: { Authorization: "Bearer " + sellers[0].accessToken },
    body: evidenceBody,
  });
  assert.equal(evidenceResponse.status, 201);
  const evidence = await evidenceResponse.json();
  await mutate(sellers[0].accessToken, "ATTACH_DOCUMENTS", claim.id, {
    type: "CLAIM",
    documentIds: [evidence.id],
  });
  assert.equal(
    (
      await fetch(base + "/files/private/" + evidence.id, {
        headers: { Authorization: "Bearer " + buyer.accessToken },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/files/private/" + evidence.id, {
        headers: { Authorization: "Bearer " + sellers[1].accessToken },
      })
    ).status,
    401,
  );
  const buyerWorkspace = await request("/workspace", buyer.accessToken);
  assert.ok(buyerWorkspace.documents.some((d) => d.id === evidence.id));
  await mutate(admin.accessToken, "CMS_UPDATE", "terms", {
    content: "Approved terms fixture",
    title: "Roxodeal Terms",
    seoDescription: "Terms for the test marketplace",
  });
  assert.equal((await request("/cms/terms")).content, "Approved terms fixture");
  assert.equal(
    (await request("/admin/reports", admin.accessToken)).totalRevenuePaise,
    payment.amount + subscriptionOrder.amount + recoveryOrder.amount,
  );
  await request("/admin/reports", buyer.accessToken, undefined, 403);
  assert.equal(
    (await request("/seller/analytics", sellers[0].accessToken)).leadsPurchased,
    await db.leadPurchase.count({ where: { sellerId: sellers[0].sellerId } }),
  );
  const publicBody = new FormData();
  const testImage = await require("sharp")({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 20, g: 60, b: 90 },
    },
  })
    .png()
    .toBuffer();
  publicBody.append(
    "file",
    new Blob([testImage], { type: "image/png" }),
    "product.png",
  );
  const imageResponse = await fetch(base + "/files/public", {
    method: "POST",
    headers: { Authorization: "Bearer " + sellers[0].accessToken },
    body: publicBody,
  });
  assert.equal(imageResponse.status, 201);
  const image = await imageResponse.json();
  const served = await fetch(image.url);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("cache-control"), /max-age=31536000/);
  assert.ok(served.headers.get("etag"));
  const revalidated = await fetch(image.url, {
    cache: "no-cache",
    headers: { "If-None-Match": served.headers.get("etag") },
  });
  assert.equal(revalidated.status, 304);
  const missingImage = await fetch(
    image.url.replace(/[^/]+$/, randomUUID() + ".webp"),
  );
  assert.equal(missingImage.status, 404);
  assert.equal(missingImage.headers.get("cache-control"), "no-store");
  assert.equal(
    served.headers.get("cross-origin-resource-policy"),
    "cross-origin",
  );
  console.log(
    "PASS: attached evidence access, public CMS, reporting roles and cross-origin processed images",
  );
  await request("/auth/forgot-password", null, { email: buyerEmail }, 201);
  await request("/auth/forgot-password", null, { email: buyerEmail }, 429);
  assert.match(mail, /Reset your Roxodeal password/);
  const refreshed = await request(
    "/auth/refresh",
    null,
    { refreshToken: buyer.refreshToken },
    201,
  );
  await request(
    "/auth/refresh",
    null,
    { refreshToken: buyer.refreshToken },
    401,
  );
  await request("/auth/logout", refreshed.accessToken, {}, 201);
  await request("/workspace", refreshed.accessToken, undefined, 401);
  console.log(
    "PASS: SMTP reset email, refresh rotation and session revocation",
  );
  const decodedMail = mail.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const resetToken = decodedMail.match(/token=([A-Za-z0-9_.%-]+)/)?.[1];
  assert.ok(resetToken, "SMTP reset message includes a usable link");
  const newPassword = password + "New";
  await request(
    "/auth/reset-password",
    null,
    { token: decodeURIComponent(resetToken), password: newPassword },
    201,
  );
  await request(
    "/auth/reset-password",
    null,
    { token: decodeURIComponent(resetToken), password: newPassword },
    400,
  );
  const relogin = await request(
    "/auth/login",
    null,
    { email: buyerEmail, password: newPassword },
    201,
  );
  assert.ok(relogin.accessToken);
  await db.user.update({
    where: { id: registered.id },
    data: { passwordHash: await hash(password) },
  });
  console.log(
    "PASS: password reset link consumption and replacement-password login",
  );
  const cacheUrl = base + "/catalogue?test=" + suffix;
  const cold = await fetch(cacheUrl);
  assert.equal(cold.headers.get("x-cache"), "MISS");
  await cold.json();
  const warm = await fetch(cacheUrl);
  assert.equal(warm.headers.get("x-cache"), "HIT");
  await warm.json();
  const wsUrl = base + "/workspace?test=" + suffix;
  await (
    await fetch(wsUrl, {
      headers: { Authorization: "Bearer " + relogin.accessToken },
    })
  ).json();
  const wsWarm = await fetch(wsUrl, {
    headers: { Authorization: "Bearer " + relogin.accessToken },
  });
  assert.equal(wsWarm.headers.get("x-cache"), "HIT");
  assert.equal(wsWarm.headers.get("cache-control"), "private, no-store");
  await wsWarm.json();
  const currentUser = await db.user.findUnique({
    where: { email: buyerEmail },
  });
  await db.user.update({
    where: { id: currentUser.id },
    data: { active: false },
  });
  try {
    const revoked = await fetch(wsUrl, {
      headers: { Authorization: "Bearer " + relogin.accessToken },
    });
    assert.equal(
      revoked.status,
      401,
      "Warm private cache must never bypass live account checks",
    );
  } finally {
    await db.user.update({
      where: { id: currentUser.id },
      data: { active: true },
    });
  }
  await mutate(admin.accessToken, "CMS_UPDATE", "terms", {
    content: "Updated cache invalidation fixture",
    title: "Roxodeal Terms",
  });
  const invalidated = await fetch(cacheUrl);
  assert.equal(invalidated.headers.get("x-cache"), "MISS");
  await invalidated.json();
  const quotas = require("redis").createClient({ url: REDIS_URL });
  await quotas.connect();
  try {
    for (const [bucket, action, path] of [
      ["requirements", "LEAD_CREATE", "/REQUIREMENTS/"],
      ["direct-requests", "ENQUIRY_CREATE", "/workspace/actions"],
    ]) {
      const key =
        "roxodeal:rate:" + database + ":user:" + currentUser.id + ":" + bucket;
      await quotas.set(key, bucket === "requirements" ? "10" : "30", {
        EX: 3600,
      });
      try {
        const limited = await fetch(base + path, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + relogin.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action,
            data: { kind: "QUOTE", sellerId: sellers[0].sellerId },
          }),
        });
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
      } finally {
        await quotas.del(key);
      }
    }
  } finally {
    await quotas.close();
  }
  console.log(
    "PASS: immutable image/304 caching, user-scoped Redis cache hits, write invalidation, live authorization on warm caches, and real submission 429 responses",
  );
  fixtures = {
    buyer: { email: buyerEmail, password },
    seller: { email: sellers[0].email, password },
    admin: { email: adminUser.email, password },
    DATABASE_URL,
    REDIS_URL,
  };
  await mkdir(path.resolve(root, "../.npm-cache"), { recursive: true });
  await writeFile(
    path.resolve(root, "../.npm-cache/live-fixtures.json"),
    JSON.stringify(fixtures),
  );
  console.log(
    "PASS: backend integration suite completed; private browser fixtures saved in ignored cache",
  );
} finally {
  api.kill();
  sms.close();
  smtp.close();
  gateway.close();
  await db.$disconnect();
}
