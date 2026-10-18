import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtService } from "@nestjs/jwt";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { hash, verify } from "argon2";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Db } from "./prisma";
import { RedisConnection } from "./redis";
import { Public, Roles, type Session } from "./security";
import {
  LoginDto,
  RegisterDto,
  LeadDto,
  LeadReviewDto,
  SellerProfileDto,
  ProductDto,
  KycReviewDto,
  PaymentOrderDto,
  PaymentVerifyDto,
} from "./dto";
import { MarketplaceService } from "./marketplace.service";
import { Payments } from "./payments";
import { kycReviewMessage } from "./kyc-review";
import { Notices } from "./notices";
type AuthRequest = Request & { user: Session; rawBody?: Buffer };
@Controller()
@ApiBearerAuth()
@ApiTags("Marketplace")
export class MarketplaceController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(MarketplaceService) private service: MarketplaceService,
    @Inject(RedisConnection) private redis: RedisConnection,
    @Inject(Notices) private notices: Notices,
  ) {}
  @Public() @Get("health") health() {
    return { status: "ok", service: "mandisetu-api" };
  }
  @Public() @Get("health/ready") async ready() {
    try {
      const [, redis] = await Promise.all([
        this.db.$queryRaw`SELECT 1`,
        this.redis.check(),
      ]);
      return { status: "ok", database: "ok", redis };
    } catch {
      throw new ServiceUnavailableException(
        "Backend dependencies are unavailable",
      );
    }
  }
  @Public() @Get("categories") categories() {
    return this.db.category.findMany({ orderBy: { name: "asc" } });
  }
  @Public() @Get("cms/:slug") async cms(@Param("slug") slug: string) {
    const page = await this.db.cmsPage.findUnique({ where: { slug } });
    return (
      page || { slug, title: "Roxodeal", content: "", seoDescription: null }
    );
  }
  @Public() @Get("plans") plans() {
    return this.db.plan.findMany({
      where: { active: true },
      orderBy: { price: "asc" },
    });
  }
  @Public() @Get("products") products(
    @Query("q") q?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.db.product.findMany({
      where: {
        active: true,
        seller: { user: { active: true } },
        ...(categoryId ? { categoryId } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        moq: true,
        unit: true,
        images: true,
        specifications: true,
        category: { select: { id: true, name: true } },
        seller: {
          select: {
            id: true,
            company: true,
            city: true,
            years: true,
            kyc: true,
          },
        },
      },
      take: 100,
    });
  }
  @Roles("SELLER") @Patch("seller/profile") profile(
    @Req() req: AuthRequest,
    @Body() dto: SellerProfileDto,
  ) {
    return this.service.profile(req.user.id, dto);
  }
  @Roles("SELLER") @Post("products") product(
    @Req() req: AuthRequest,
    @Body() dto: ProductDto,
  ) {
    return this.service.addProduct(req.user.id, dto);
  }
  @Roles("BUYER") @Post("requirements") requirement(
    @Req() req: AuthRequest,
    @Body() dto: LeadDto,
  ) {
    return this.service.createLead(req.user.id, dto);
  }
  @Roles("BUYER") @Get("requirements") requirements(@Req() req: AuthRequest) {
    return this.db.lead.findMany({
      where: { buyerId: req.user.id },
      include: { _count: { select: { purchases: true } } },
    });
  }
  @Roles("SELLER") @Get("leads") leads(@Req() req: AuthRequest) {
    return this.service.leads(req.user.id);
  }
  @Roles("SELLER") @Post("leads/:id/unlock") unlock(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.service.unlock(req.user.id, id);
  }
  @Roles("ADMIN") @Get("admin/leads") allLeads() {
    return this.db.lead.findMany({
      include: {
        buyer: { select: { id: true, name: true, email: true, phone: true } },
        purchases: {
          include: { seller: { select: { id: true, company: true } } },
        },
      },
    });
  }
  @Roles("ADMIN") @Patch("admin/leads/:id") reviewLead(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Body() dto: LeadReviewDto,
  ) {
    return this.service.reviewLead(req.user.id, id, dto);
  }
  @Roles("ADMIN") @Get("admin/sellers") sellers() {
    return this.db.seller.findMany({
      include: {
        user: { select: { name: true, email: true, phone: true } },
        plan: true,
        categories: { include: { category: true } },
      },
    });
  }
  @Roles("ADMIN") @Patch("admin/kyc/:id") async kyc(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Body() dto: KycReviewDto,
  ) {
    const note = kycReviewMessage(dto.status, dto.note);
    const result = await this.db.$transaction(async (tx) => {
      const seller = await tx.seller.update({
        where: { id },
        data: { kyc: dto.status, kycNote: note },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "KYC_REVIEW",
          targetId: id,
          details: { status: dto.status, note },
        },
      });
      return seller;
    });
    await this.notices.send(
      result.userId,
      `Your KYC status is ${dto.status.replaceAll("_", " ")}. ${note}`,
    );
    return result;
  }
  @Get("notifications") notifications(@Req() req: AuthRequest) {
    return this.db.notification.findMany({
      where: { userId: req.user.id },
      take: 50,
      orderBy: { createdAt: "desc" },
    });
  }
  @Get("payments") payments(@Req() req: AuthRequest) {
    return this.db.payment.findMany({
      where: req.user.role === "ADMIN" ? {} : { userId: req.user.id },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  }
  @Get("payments/:id/receipt") async receipt(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    const payment = await this.db.payment.findFirst({
      where: {
        id,
        ...(req.user.role === "ADMIN" ? {} : { userId: req.user.id }),
      },
      include: { user: { select: { name: true, email: true, company: true } } },
    });
    if (!payment || payment.status !== "CAPTURED")
      throw new BadRequestException("Verified payment receipt is unavailable");
    return {
      receiptNumber: payment.id,
      issuedAt: payment.createdAt,
      business: "Roxodeal",
      customer: payment.user,
      amountPaise: payment.amount,
      currency: "INR",
      type: payment.type,
      gatewayPaymentId: payment.gatewayPaymentId,
    };
  }
}
@Controller("files")
@ApiBearerAuth()
@ApiTags("Private files")
export class FilesController {
  constructor(@Inject(Db) private db: Db) {}
  @Roles("SELLER")
  @Post("public")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async publicUpload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Image is required");
    let buffer: Buffer;
    try {
      const metadata = await sharp(file.buffer, {
        limitInputPixels: 30000000,
      }).metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format || ""))
        throw new Error();
      buffer = await sharp(file.buffer, { limitInputPixels: 30000000 })
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      throw new BadRequestException(
        "Only JPEG, PNG and WebP images are supported",
      );
    }
    const root = path.resolve(
      process.env.PUBLIC_UPLOAD_DIR || "uploads/public",
    );
    await mkdir(root, { recursive: true });
    const key = randomUUID() + ".webp";
    await writeFile(path.join(root, key), buffer, { flag: "wx" });
    return {
      url:
        (process.env.PUBLIC_FILE_BASE_URL ||
          "http://localhost:4000/api/files/public") +
        "/" +
        key,
    };
  }
  @Public() @Get("public/:key") publicImage(
    @Param("key") key: string,
    @Res() res: Response,
  ) {
    if (!/^[a-f0-9-]{36}\.webp$/.test(key))
      throw new BadRequestException("Invalid image");
    const root = path.resolve(
      process.env.PUBLIC_UPLOAD_DIR || "uploads/public",
    );
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Uploads always receive a new UUID: safe for browser/CDN immutable caching.
    // sendFile also supports ETag/Last-Modified and conditional 304 responses.
    res.sendFile(
      path.join(root, key),
      { maxAge: "1y", immutable: true, dotfiles: "deny" },
      (error) => {
        if (!error) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res
          .status(
            (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500,
          )
          .end();
      },
    );
  }
  @Roles("BUYER", "SELLER")
  @Post("private")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(
    @Req() req: AuthRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body("purpose") requestedPurpose?: string,
  ) {
    if (!file) throw new BadRequestException("File is required");
    const purpose =
      requestedPurpose || (req.user.role === "SELLER" ? "KYC" : "CLAIM");
    const allowed =
      req.user.role === "SELLER"
        ? ["KYC", "CLAIM"]
        : ["CLAIM", "LEAD", "PROTECTION"];
    if (!allowed.includes(purpose))
      throw new BadRequestException("Invalid document purpose");
    const root = path.resolve(
      process.env.PRIVATE_UPLOAD_DIR || "uploads/private",
    );
    await mkdir(root, { recursive: true });
    let buffer = file.buffer;
    let ext: string;
    let mime: string;
    if (buffer.subarray(0, 5).toString() === "%PDF-") {
      ext = ".pdf";
      mime = "application/pdf";
    } else {
      try {
        const metadata = await sharp(buffer, {
          limitInputPixels: 30000000,
        }).metadata();
        if (!["jpeg", "png", "webp"].includes(metadata.format || ""))
          throw new Error();
        buffer = await sharp(buffer)
          .rotate()
          .resize(2400, 2400, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
        ext = ".webp";
        mime = "image/webp";
      } catch {
        throw new BadRequestException(
          "Only PDF, JPEG, PNG, or WebP documents are supported",
        );
      }
    }
    const key = randomUUID() + ext;
    await writeFile(path.join(root, key), buffer, { flag: "wx" });
    const doc = await this.db.document.create({
      data: {
        ownerId: req.user.id,
        filename: path.basename(file.originalname),
        storageKey: key,
        mimeType: mime,
        purpose,
      },
    });
    return { id: doc.id, filename: doc.filename };
  }
  @Get("private/:id") async stream(
    @Req() req: AuthRequest,
    @Res() res: Response,
    @Param("id") id: string,
  ) {
    const doc = await this.db.document.findUnique({ where: { id } });
    if (!doc) throw new UnauthorizedException();
    if (doc.ownerId !== req.user.id && req.user.role !== "ADMIN") {
      const claim =
        doc.purpose === "CLAIM"
          ? await this.db.claim.findFirst({
              where: {
                documentIds: { has: id },
                OR: [
                  { buyerId: req.user.id },
                  { seller: { userId: req.user.id } },
                ],
              },
            })
          : null;
      const lead =
        doc.purpose === "LEAD"
          ? await this.db.lead.findFirst({
              where: {
                documentIds: { has: id },
                purchases: { some: { seller: { userId: req.user.id } } },
              },
            })
          : null;
      if (!claim && !lead) throw new UnauthorizedException();
    }
    const root = path.resolve(
      process.env.PRIVATE_UPLOAD_DIR || "uploads/private",
    );
    const full = path.resolve(root, doc.storageKey);
    if (!full.startsWith(root + path.sep)) throw new UnauthorizedException();
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="document' + path.extname(doc.storageKey) + '"',
    );
    res.setHeader("Cache-Control", "private, no-store");
    const stream = createReadStream(full);
    stream.on("error", () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
  }
}
@Controller("payments")
@ApiTags("Payments")
export class PaymentsController {
  constructor(@Inject(Payments) private payments: Payments) {}
  @Roles("SELLER", "BUYER") @Post("verify") @ApiBearerAuth() verify(
    @Req() req: AuthRequest,
    @Body() dto: PaymentVerifyDto,
  ) {
    return this.payments.verify(req.user.id, dto);
  }
  @Roles("SELLER", "BUYER")
  @Get("orders/:orderId/status")
  @ApiBearerAuth()
  status(@Req() req: AuthRequest, @Param("orderId") orderId: string) {
    return this.payments.checkStatus(req.user.id, orderId);
  }
  @Roles("SELLER", "BUYER") @Post("orders") @ApiBearerAuth() order(
    @Req() req: AuthRequest,
    @Body() dto: PaymentOrderDto,
  ) {
    if ((req.user.role === "BUYER") !== (dto.type === "PROTECTION"))
      throw new UnauthorizedException(
        "Payment type does not match your account",
      );
    return this.payments.order(req.user.id, dto.type, dto.targetId);
  }
  @Public() @Post("webhook") webhook(
    @Req() req: AuthRequest,
    @Headers("x-razorpay-signature") signature: string,
  ) {
    if (!req.rawBody) throw new BadRequestException("Raw webhook body missing");
    return this.payments.webhook(req.rawBody, signature || "");
  }
}
