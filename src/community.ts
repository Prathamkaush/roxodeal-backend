import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Db } from "./prisma";
import { Public, Roles } from "./security";
import { RedisConnection } from "./redis";

export class ContactDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(3) @MaxLength(200) subject!: string;
  @IsString() @MinLength(10) @MaxLength(5000) message!: string;
}
export class FeedbackDto {
  @IsString() @MinLength(10) @MaxLength(3000) message!: string;
}
export class ReviewDto extends FeedbackDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MinLength(1) sellerId?: string;
  @IsOptional() @IsString() @MinLength(1) productId?: string;
}
@Controller()
export class CommunityController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(RedisConnection) private redis: RedisConnection,
  ) {}
  @Public() @Post("contact") async contact(
    @Body() dto: ContactDto,
    @Req() req: any,
  ) {
    if (
      dto.name.trim().length < 2 ||
      dto.subject.trim().length < 3 ||
      dto.message.trim().length < 10
    )
      throw new BadRequestException("Complete all message fields");
    const message = await this.db.contactMessage.create({
      data: {
        name: dto.name.trim(),
        email: dto.email.trim().toLowerCase(),
        subject: dto.subject.trim(),
        message: dto.message.trim(),
      },
    });
    return { id: message.id, ok: true };
  }
  @Post("feedback") async feedback(@Body() dto: FeedbackDto, @Req() req: any) {
    if (dto.message.trim().length < 10)
      throw new BadRequestException("Enter at least 10 characters");
    const saved = await this.db.feedback.create({
      data: {
        userId: req.user.id,
        kind: "FEEDBACK",
        message: dto.message.trim(),
      },
    });
    return { id: saved.id, ok: true };
  }
  @Post("reviews") async review(@Body() dto: ReviewDto, @Req() req: any) {
    if (req.user.role !== "BUYER")
      throw new BadRequestException("Use a buyer account to leave a review");
    if (dto.message.trim().length < 10)
      throw new BadRequestException("Enter at least 10 characters");
    let sellerId = dto.sellerId;
    if (dto.productId) {
      const product = await this.db.product.findFirst({
        where: {
          id: dto.productId,
          active: true,
          seller: { user: { active: true } },
        },
      });
      if (!product || (sellerId && sellerId !== product.sellerId))
        throw new BadRequestException("Choose a valid product and supplier");
      sellerId = product.sellerId;
    }
    if (
      sellerId &&
      !(await this.db.seller.findFirst({
        where: { id: sellerId, user: { active: true } },
      }))
    )
      throw new BadRequestException("Supplier unavailable");
    const targetKey = dto.productId
      ? "product:" + dto.productId
      : sellerId
        ? "seller:" + sellerId
        : "marketplace";
    const data = {
      kind: "REVIEW",
      message: dto.message.trim(),
      rating: dto.rating,
      sellerId: sellerId || null,
      productId: dto.productId || null,
    };
    const saved = await this.db.feedback.upsert({
      where: { userId_targetKey: { userId: req.user.id, targetKey } },
      create: { ...data, userId: req.user.id, targetKey },
      update: data,
    });
    return { id: saved.id, ok: true };
  }
  @Public() @Get("reviews") async reviews(
    @Query("sellerId") sellerId?: string,
    @Query("productId") productId?: string,
    @Query("page") input = "1",
  ) {
    const page = Number(input);
    if (!Number.isInteger(page) || page < 1 || page > 10000)
      throw new BadRequestException("Invalid page");
    const where = {
      kind: "REVIEW",
      user: { active: true },
      ...(sellerId ? { sellerId } : {}),
      ...(productId ? { productId } : {}),
      ...(!sellerId && !productId ? { targetKey: "marketplace" } : {}),
    };
    const [items, total, summary] = await Promise.all([
      this.db.feedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 10,
        take: 10,
        select: {
          id: true,
          message: true,
          rating: true,
          createdAt: true,
          user: { select: { name: true, city: true } },
        },
      }),
      this.db.feedback.count({ where }),
      this.db.feedback.aggregate({ where, _avg: { rating: true } }),
    ]);
    return { items, total, average: summary._avg.rating, page, pageSize: 10 };
  }
  @Roles("ADMIN") @Get("admin/contact-messages") messages() {
    return this.db.contactMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Roles("ADMIN") @Get("admin/feedback") feedbackInbox() {
    return this.db.feedback.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { name: true, email: true } } },
    });
  }
}
