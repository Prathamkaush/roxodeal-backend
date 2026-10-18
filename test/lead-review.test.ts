import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LeadReviewDto } from "../src/dto";
import { MarketplaceService } from "../src/marketplace.service";
import { WorkspaceService } from "../src/workspace";

test("Save review workspace request accepts an unchanged status omitted by the admin form", async () => {
  const reviews: any[] = [];
  const workspace = new WorkspaceService(
    { auditLog: { create: async () => ({}) } } as any,
    {
      reviewLead: async (...args: any[]) => {
        reviews.push(args);
        return { id: "lead-1" };
      },
    } as any,
    {} as any,
    {} as any,
  );
  const result = await workspace.mutate({ id: "admin", role: "ADMIN" } as any, {
    action: "LEAD_REVIEW",
    id: "lead-1",
    data: { price: 199 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reviews, [["admin", "lead-1", { price: 19900 }]]);
});

test("admin lead review accepts only moderation statuses or a price-only update", async () => {
  for (const status of ["ACTIVE", "PENDING", "REJECTED", undefined]) {
    const dto = plainToInstance(LeadReviewDto, {
      price: 2500,
      ...(status ? { status } : {}),
    });
    assert.equal((await validate(dto)).length, 0);
  }
  for (const status of ["PARTIALLY_SOLD", "FULLY_SOLD", "CLOSED", "EXPIRED"]) {
    const dto = plainToInstance(LeadReviewDto, { price: 2500, status });
    assert.ok(
      (await validate(dto)).some((error) => error.property === "status"),
    );
    const service = new MarketplaceService({} as any);
    await assert.rejects(
      service.reviewLead("admin", "lead", dto),
      /only Active, Pending, and Rejected/,
    );
  }
});

test("changing price preserves a user-managed lead status and sends no activation notice", async () => {
  const existing = { id: "lead", status: "CLOSED", price: 1000 };
  let updateData: unknown;
  let audit: any;
  const tx = {
    $queryRaw: async () => [],
    leadPurchase: { count: async () => 1 },
    lead: {
      update: async ({ data }: any) => {
        updateData = data;
        return { ...existing, ...data };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        audit = data;
      },
    },
    seller: {
      findMany: async () => {
        assert.fail("Price changes must not send activation notices");
      },
    },
  };
  const service = new MarketplaceService({
    $transaction: (fn: any) => fn(tx),
  } as any);
  const result = await service.reviewLead("admin", "lead", { price: 2500 });
  assert.deepEqual(updateData, { price: 2500 });
  assert.equal(result.status, "CLOSED");
  assert.equal(result.price, 2500);
  assert.equal(audit.action, "LEAD_REVIEW");
});
