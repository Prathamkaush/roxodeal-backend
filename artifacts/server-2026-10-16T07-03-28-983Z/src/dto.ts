import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  Min,
  MinLength,
  IsOptional,
  IsISO8601,
  Max,
  IsArray,
  ArrayMaxSize,
  IsUrl,
  Matches,
  MaxLength,
  IsObject,
} from "class-validator";
import { KycStatus, LeadStatus, Role } from "@prisma/client";
import { Transform } from "class-transformer";
export class RegisterDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @IsString() @Matches(/^\+?[1-9]\d{7,14}$/) phone!: string;
  @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]*$/u)
  name!: string;
  @IsEnum({ BUYER: Role.BUYER, SELLER: Role.SELLER }) role!: Role;
}
export class LoginDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
export class LeadDto {
  @IsString() @MinLength(5) title!: string;
  @IsString() categoryId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsString() unit!: string;
  @IsInt() @Min(1) budget!: number;
  @IsString() @MinLength(2) city!: string;
  @IsString() @MinLength(10) description!: string;
  @IsISO8601() requiredBy!: string;
  @IsOptional() @IsString() subcategory?: string;
}
export class LeadReviewDto {
  @IsOptional() @IsIn(["ACTIVE", "PENDING", "REJECTED"]) status?: LeadStatus;
  @IsInt() @Min(0) price!: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) maxSlots?: number;
}
export class KycReviewDto {
  @IsEnum(KycStatus) status!: KycStatus;
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class SellerProfileDto {
  @IsString() @MinLength(2) company!: string;
  @IsString() city!: string;
  @IsString() state!: string;
  @IsString() address!: string;
  @IsString() pincode!: string;
  @IsOptional() @IsString() gst?: string;
  @IsOptional() @IsString() pan?: string;
  @IsInt() @Min(0) years!: number;
  @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) categoryIds!: string[];
}
export class ProductDto {
  @IsString() @MinLength(3) name!: string;
  @IsString() @MinLength(10) description!: string;
  @IsString() categoryId!: string;
  @IsInt() @Min(0) price!: number;
  @IsInt() @Min(1) moq!: number;
  @IsString() unit!: string;
  @IsArray()
  @ArrayMaxSize(8)
  @IsUrl(
    {
      require_tld: false,
      protocols: ["http", "https"],
      require_protocol: true,
    },
    { each: true },
  )
  images!: string[];
  @IsOptional() @IsObject() specifications?: Record<string, string>;
  @IsOptional() @IsString() subcategory?: string;
  @IsOptional() @IsInt() @Min(0) maximumPrice?: number;
}
export class PaymentOrderDto {
  @IsEnum({
    LEAD: "LEAD",
    SUBSCRIPTION: "SUBSCRIPTION",
    PROTECTION: "PROTECTION",
  })
  type!: "LEAD" | "SUBSCRIPTION" | "PROTECTION";
  @IsString() targetId!: string;
}
export class PaymentVerifyDto {
  @IsString() @Matches(/^order_[a-zA-Z0-9_]+$/) orderId!: string;
  @IsString() @Matches(/^pay_[a-zA-Z0-9_]+$/) paymentId!: string;
  @IsString() @Matches(/^[a-fA-F0-9]{64}$/) signature!: string;
}
