ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
-- Administrators are provisioned by the trusted server-side seed, not public registration.
UPDATE "User" SET "emailVerified" = true WHERE role = 'ADMIN';

CREATE TABLE "EmailVerificationChallenge" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailVerificationChallenge_email_createdAt_idx" ON "EmailVerificationChallenge"("email", "createdAt");
