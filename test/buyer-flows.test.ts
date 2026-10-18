import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { WorkspaceService } from "../src/workspace";
import { CommunityController, ContactDto, ReviewDto } from "../src/community";

const buyer = { id: "buyer-1", role: "BUYER", sessionId: "session" } as const;
function requests() {
  const created: any[] = [],
    notices: any[] = [],
    deletions: any[] = [];
  const db = {
    seller: {
      findFirst: async () => ({ id: "seller-1", userId: "seller-user" }),
    },
    product: {
      findFirst: async ({ where }: any) =>
        where.id === "product-1" && where.sellerId === "seller-1"
          ? { id: "product-1" }
          : null,
    },
    enquiry: {
      create: async ({ data }: any) => {
        created.push(data);
        return { id: "request-1" };
      },
    },
    notification: {
      deleteMany: async ({ where }: any) => {
        deletions.push(where);
        return { count: 0 };
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return {
    created,
    notices,
    deletions,
    service: new WorkspaceService(
      db as any,
      {} as any,
      {
        send: async (...args: any[]) => {
          notices.push(args);
        },
      } as any,
      {} as any,
    ),
  };
}
test("quotes target exactly one seller/product and never create marketplace leads", async () => {
  const { service, created, notices } = requests();
  await service.mutate(buyer, {
    action: "ENQUIRY_CREATE",
    data: {
      kind: "QUOTE",
      sellerId: "seller-1",
      productId: "product-1",
      quantity: 20,
      message: "Please quote for 20 pieces.",
    },
  });
  assert.deepEqual(created, [
    {
      buyerId: buyer.id,
      sellerId: "seller-1",
      productId: "product-1",
      kind: "QUOTE",
      quantity: 20,
      message: "Please quote for 20 pieces.",
    },
  ]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], "seller-user");
});
test("quotes reject mismatched products and invalid quantities before creating requests", async () => {
  const { service, created } = requests();
  for (const data of [
    { productId: "wrong-product", quantity: 20 },
    { productId: "product-1", quantity: 0 },
    { productId: "product-1", quantity: 1.5 },
    { quantity: 20 },
  ])
    await assert.rejects(
      service.mutate(buyer, {
        action: "ENQUIRY_CREATE",
        data: {
          kind: "QUOTE",
          sellerId: "seller-1",
          message: "Please send a quotation.",
          ...data,
        },
      }),
    );
  assert.equal(created.length, 0);
});
test("general enquiries need no product or quantity; notification deletion is owner scoped", async () => {
  const { service, created, deletions } = requests();
  await service.mutate(buyer, {
    action: "ENQUIRY_CREATE",
    data: { sellerId: "seller-1", message: "Do you offer customisation?" },
  });
  assert.equal(created[0].kind, "ENQUIRY");
  assert.equal(created[0].quantity, null);
  await service.mutate(buyer, {
    action: "NOTIFICATION_DELETE",
    id: "someone-elses-notification",
    data: {},
  });
  assert.deepEqual(deletions, [
    { id: "someone-elses-notification", userId: buyer.id },
  ]);
});
test("contact and review validation rejects bad email, short messages, and invalid ratings", async () => {
  assert.ok(
    (
      await validate(
        plainToInstance(ContactDto, {
          name: "Jo",
          email: "invalid",
          subject: "Help",
          message: "Too short",
        }),
      )
    ).length,
  );
  for (const rating of [0, 6, 1.5])
    assert.ok(
      (
        await validate(
          plainToInstance(ReviewDto, {
            rating,
            message: "A useful and detailed review.",
          }),
        )
      ).length,
    );
});
test("private feedback and public reviews use different storage kinds; reviews expose no contact fields", async () => {
  const writes: any[] = [],
    reads: any[] = [];
  const controller = new CommunityController(
    {
      feedback: {
        create: async ({ data }: any) => {
          writes.push(data);
          return { id: "feedback" };
        },
        upsert: async ({ create }: any) => {
          writes.push(create);
          return { id: "review" };
        },
        findMany: async (query: any) => {
          reads.push(query);
          return [];
        },
        count: async () => 0,
        aggregate: async () => ({ _avg: { rating: null } }),
      },
    } as any,
    { limit: async () => true } as any,
  );
  await controller.feedback(
    { message: "Please improve the search." },
    { user: buyer },
  );
  await controller.review(
    { rating: 4, message: "A helpful marketplace experience." },
    { user: buyer },
  );
  assert.equal(writes[0].kind, "FEEDBACK");
  assert.equal(writes[1].kind, "REVIEW");
  await controller.reviews(undefined, undefined, "1");
  assert.equal(reads[0].where.kind, "REVIEW");
  assert.deepEqual(reads[0].select.user.select, { name: true, city: true });
  await assert.rejects(controller.reviews(undefined, undefined, "0"));
});
