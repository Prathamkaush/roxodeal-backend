import { BadRequestException } from "@nestjs/common";
import { KycStatus } from "@prisma/client";

export function kycReviewMessage(status: KycStatus, input: unknown): string {
  if (input !== undefined && typeof input !== "string")
    throw new BadRequestException("Message to seller must be text");
  const note = typeof input === "string" ? input.trim() : "";
  const requiresReason = status === "REJECTED" || status === "ADDITIONAL_DOCUMENTS_REQUIRED";
  if (requiresReason && note.length < 10)
    throw new BadRequestException("Write a message to the seller of at least 10 characters explaining the rejection or which documents are needed");
  if (note.length > 2000)
    throw new BadRequestException("Message to seller must be at most 2000 characters");
  return note || "Reviewed by administrator";
}
