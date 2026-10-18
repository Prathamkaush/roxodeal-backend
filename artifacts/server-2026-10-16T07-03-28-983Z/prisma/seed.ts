import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hash } from "argon2";
const environmentFile = resolve(__dirname, "../.env");
config({ path: environmentFile, quiet: true });
const db = new PrismaClient();
async function seed() {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 12)
    throw new Error(
      `Admin password must have at least 12 characters (received ${process.env.ADMIN_PASSWORD.length}). Check ${environmentFile} and any ADMIN_PASSWORD process environment override.`,
    );
  for (const name of [
    "Industrial Machinery",
    "Packaging Materials",
    "Raw Textiles",
    "Electronics & Components",
    "Construction Materials",
    "Chemical & Distribution",
    "Agricultural Equipment",
    "Furniture & Wood",
    "Automotive Parts",
    "Food & Beverage",
    "Medical & Healthcare Supplies",
    "Plastics & Polymers",
  ])
    await db.category.upsert({ where: { name }, create: { name }, update: {} });
  for (const [name, price, listingLimit, leadCredits] of [
    ["Free", 0, 5, 0],
    ["Bronze", 99900, 20, 5],
    ["Silver", 249900, 40, 15],
    ["Gold", 499900, 80, 30],
  ] as [string, number, number, number][])
    await db.plan.upsert({
      where: { name },
      create: { name, price, listingLimit, leadCredits },
      update: {},
    });
  if (
    process.env.ADMIN_EMAIL &&
    process.env.ADMIN_PASSWORD &&
    process.env.ADMIN_PHONE
  ) {
    await db.user.upsert({
      where: { email: process.env.ADMIN_EMAIL },
      create: {
        email: process.env.ADMIN_EMAIL,
        phone: process.env.ADMIN_PHONE,
        name: "Super Admin",
        role: "ADMIN",
        passwordHash: await hash(process.env.ADMIN_PASSWORD),
        phoneVerified: true,
        emailVerified: true,
      },
      update: {},
    });
  }
  for (const [slug, content] of [
    [
      "about",
      "Roxodeal connects buyers with manufacturers across India. Post free requirements and negotiate directly with relevant suppliers.",
    ],
    [
      "faq",
      "Requirements are free for buyers. A maximum of five relevant suppliers can unlock a lead. Buyer protection claims are reviewed manually.",
    ],
  ])
    await db.cmsPage.upsert({
      where: { slug },
      create: { slug, title: slug, content },
      update: {},
    });
  console.log(
    "Categories and plans seeded. Admin is created only when ADMIN_* credentials are provided.",
  );
}
seed().finally(() => db.$disconnect());
