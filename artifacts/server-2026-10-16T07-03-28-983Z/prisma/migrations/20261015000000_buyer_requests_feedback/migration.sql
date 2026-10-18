ALTER TABLE "Enquiry" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ENQUIRY', ADD COLUMN "quantity" INTEGER;
CREATE TABLE "ContactMessage" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "email" TEXT NOT NULL,
  "subject" TEXT NOT NULL, "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Feedback" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "message" TEXT NOT NULL, "rating" INTEGER, "sellerId" TEXT, "productId" TEXT,
  "targetKey" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Feedback_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  CONSTRAINT "Feedback_kind_check" CHECK ("kind" IN ('FEEDBACK', 'REVIEW'))
);
CREATE UNIQUE INDEX "Feedback_userId_targetKey_key" ON "Feedback"("userId", "targetKey");
CREATE INDEX "Feedback_kind_sellerId_productId_idx" ON "Feedback"("kind", "sellerId", "productId");
