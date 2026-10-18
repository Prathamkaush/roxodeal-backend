import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { MutationDto, WorkspaceService } from "../src/workspace";
import { MarketplaceService } from "../src/marketplace.service";

const buyer = { id: "buyer", role: "BUYER", sessionId: "test" } as const;
test("workspace validator accepts notification deletion and buyer lifecycle actions", async () => {
  for (const action of [
    "NOTIFICATION_DELETE",
    "BUYER_LEAD_STATUS",
    "BUYER_LEAD_DELETE",
  ]) {
    assert.equal(
      (
        await validate(
          plainToInstance(MutationDto, { action, id: "lead", data: {} }),
        )
      ).length,
      0,
    );
  }
});
test("buyers close/fulfil only their own requirements; deletion preserves stored records", async () => {
  const lead = {
    id: "lead",
    buyerId: buyer.id,
    status: "ACTIVE",
    deletedAt: null as Date | null,
  };
  const tx = {
    $queryRaw: async () => [],
    lead: {
      findUnique: async () => lead,
      update: async ({ data }: any) => Object.assign(lead, data),
    },
  };
  const service = new WorkspaceService(
    {
      $transaction: (fn: any) => fn(tx),
      auditLog: { create: async () => ({}) },
    } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  for (const status of ["Closed", "Fully Sold"]) {
    await service.mutate(buyer, {
      action: "BUYER_LEAD_STATUS",
      id: lead.id,
      data: { status },
    });
    assert.equal(lead.status, status.toUpperCase().replaceAll(" ", "_"));
  }
  await assert.rejects(
    service.mutate(buyer, {
      action: "BUYER_LEAD_STATUS",
      id: lead.id,
      data: { status: "Active" },
    }),
  );
  await assert.rejects(
    service.mutate(
      { ...buyer, id: "other" },
      { action: "BUYER_LEAD_DELETE", id: lead.id, data: {} },
    ),
  );
  assert.equal(lead.deletedAt, null);
  await service.mutate(buyer, {
    action: "BUYER_LEAD_DELETE",
    id: lead.id,
    data: {},
  });
  assert.ok(lead.deletedAt instanceof Date);
  assert.equal(lead.status, "CLOSED");
});
test("supplier unlock capacity does not set buyer fulfilment status", async () => {
  const tx = {
    $queryRaw: async () => [],
    lead: {
      findUnique: async () => ({ id: "lead" }),
      findUniqueOrThrow: async () => ({
        id: "lead",
        categoryId: "category",
        status: "ACTIVE",
        price: 0,
        maxSlots: 5,
        purchases: [
          { sellerId: "s1" },
          { sellerId: "s2" },
          { sellerId: "s3" },
          { sellerId: "s4" },
        ],
      }),
      update: async () => {
        assert.fail("Contact unlocks cannot decide buyer fulfilment");
      },
    },
    seller: {
      findUnique: async () => ({
        id: "s5",
        categories: [{ categoryId: "category" }],
      }),
      findUniqueOrThrow: async () => ({ id: "s5" }),
    },
    leadPurchase: { create: async () => ({ id: "purchase" }) },
    auditLog: { create: async () => ({}) },
  };
  const service = new MarketplaceService({} as any);
  assert.equal(
    (await service.unlock("supplier-user", "lead", undefined, tx as any)).id,
    "purchase",
  );
});
