import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { hash, verify } from "argon2";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  IsEmail,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from "class-validator";
import { Db } from "./prisma";
import { Prisma } from "@prisma/client";
import { Public, Session } from "./security";
import { LoginDto, RegisterDto } from "./dto";
import { Delivery } from "./delivery";
class RefreshDto {
  @IsString() @MinLength(32) refreshToken!: string;
}
class PhoneDto {
  @IsString() @Matches(/^\+?[1-9]\d{7,14}$/) phone!: string;
}
class VerifyDto extends PhoneDto {
  @IsString() @Matches(/^\d{6}$/) code!: string;
}
class ForgotDto {
  @IsEmail() email!: string;
}
class EmailVerifyDto extends ForgotDto {
  @IsString() @Matches(/^\d{6}$/) code!: string;
}
class ResetDto {
  @IsString() token!: string;
  @IsString() @MinLength(10) @MaxLength(128) password!: string;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
@Injectable()
export class AuthService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(JwtService) private jwt: JwtService,
    @Inject(Delivery) private delivery: Delivery,
  ) {}
  async tokens(
    userId: string,
    sessionId?: string,
    client: Prisma.TransactionClient = this.db,
  ) {
    const refreshToken = randomBytes(48).toString("base64url");
    const data = {
      refreshHash: digest(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 86400000),
    };
    const session = sessionId
      ? await client.authSession.update({ where: { id: sessionId }, data })
      : await client.authSession.create({ data: { ...data, userId } });
    const user = await client.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return {
      accessToken: await this.jwt.signAsync({ sub: userId, sid: session.id }),
      refreshToken,
      expiresIn: 3600,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        phoneVerified: user.phoneVerified,
        emailVerified: user.emailVerified,
      },
    };
  }
  async register(dto: RegisterDto) {
    const [emailExists, phoneExists] = await Promise.all([
      this.db.user.findUnique({ where: { email: dto.email.toLowerCase() } }),
      this.db.user.findUnique({ where: { phone: dto.phone } }),
    ]);
    if (emailExists)
      throw new BadRequestException(
        "This email address is already registered. Sign in or use Forgot password.",
      );
    if (phoneExists)
      throw new BadRequestException(
        "This mobile number is already registered. Use a different mobile number or sign in to its existing account.",
      );
    const { password, ...data } = dto;
    const free = await this.db.plan.findUnique({ where: { name: "Free" } });
    const user = await this.db.user.create({
      data: {
        ...data,
        email: dto.email.toLowerCase(),
        passwordHash: await hash(password),
        ...(dto.role === "SELLER"
          ? {
              seller: {
                create: {
                  company: dto.name,
                  city: "",
                  state: "",
                  address: "",
                  pincode: "",
                  planId: free?.id,
                },
              },
            }
          : {}),
      },
    });
    return {
      id: user.id,
      phoneVerified: false,
      emailVerified: false,
      message: "Account created. Verify your email address to sign in.",
    };
  }
  async login(dto: LoginDto) {
    return this.db.$transaction(async (tx) => {
      const email = dto.email.toLowerCase();
      await tx.$queryRaw`SELECT id FROM "User" WHERE email=${email} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email } });
      if (!user?.active || !(await verify(user.passwordHash, dto.password)))
        throw new UnauthorizedException("Invalid credentials");
      if (!user.emailVerified)
        throw new UnauthorizedException("Email verification is required");
      return this.tokens(user.id, undefined, tx);
    });
  }
  async refresh(token: string) {
    return this.db.$transaction(async (tx) => {
      const session = await tx.authSession.findUnique({
        where: { refreshHash: digest(token) },
        include: { user: true },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt < new Date() ||
        !session.user.active ||
        !session.user.emailVerified
      )
        throw new UnauthorizedException("Session expired");
      await tx.$queryRaw`SELECT id FROM "AuthSession" WHERE id=${session.id} FOR UPDATE`;
      const fresh = await tx.authSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      if (fresh.refreshHash !== digest(token) || fresh.revokedAt)
        throw new UnauthorizedException("Session expired");
      const refreshToken = randomBytes(48).toString("base64url");
      await tx.authSession.update({
        where: { id: session.id },
        data: { refreshHash: digest(refreshToken) },
      });
      return {
        accessToken: await this.jwt.signAsync({
          sub: session.userId,
          sid: session.id,
        }),
        refreshToken,
        expiresIn: 3600,
        user: {
          id: session.user.id,
          name: session.user.name,
          role: session.user.role,
        },
      };
    });
  }
  async sendEmailVerification(email: string) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
      throw new ServiceUnavailableException(
        "Email delivery is not configured. Contact support.",
      );
    email = email.toLowerCase();
    const code = String(randomInt(100000, 1000000));
    const challenge = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE email=${email} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email } });
      if (!user?.active || user.emailVerified) return null;
      const recent = await tx.emailVerificationChallenge.count({
        where: { email, createdAt: { gt: new Date(Date.now() - 3600000) } },
      });
      if (recent >= 5) {
        const oldest = await tx.emailVerificationChallenge.findFirst({
          where: { email, createdAt: { gt: new Date(Date.now() - 3600000) } },
          orderBy: { createdAt: "asc" },
        });
        const retryAfter = Math.max(
          1,
          Math.ceil(
            ((oldest?.createdAt.getTime() || Date.now()) +
              3600000 -
              Date.now()) /
              1000,
          ),
        );
        throw new HttpException(
          {
            statusCode: 429,
            message:
              "You have reached the hourly verification email limit. Please try again later.",
            retryAfter,
          },
          429,
        );
      }
      const last = await tx.emailVerificationChallenge.findFirst({
        where: { email },
        orderBy: { createdAt: "desc" },
      });
      if (last && Date.now() - last.createdAt.getTime() < 60000)
        throw new HttpException(
          {
            statusCode: 429,
            message: "Please wait before requesting another verification code.",
            retryAfter: Math.max(
              1,
              Math.ceil((last.createdAt.getTime() + 60000 - Date.now()) / 1000),
            ),
          },
          429,
        );
      return tx.emailVerificationChallenge.create({
        data: {
          email,
          hash: await hash(code),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
    });
    if (challenge) {
      try {
        await this.delivery.email(
          email,
          "Verify your Roxodeal email",
          `Your Roxodeal email verification code is ${code}. It expires in 10 minutes.`,
        );
      } catch (error) {
        await this.db.emailVerificationChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
        throw error;
      }
    }
    return {
      message: "If verification is needed, a code has been sent to your email.",
      resendAfter: 60,
    };
  }
  async verifyEmail(dto: EmailVerifyDto) {
    const email = dto.email.toLowerCase();
    const verified = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE email=${email} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email } });
      if (!user?.active || user.emailVerified) return false;
      const challenge = await tx.emailVerificationChallenge.findFirst({
        where: { email },
        orderBy: { createdAt: "desc" },
      });
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt < new Date() ||
        challenge.attempts >= 5
      )
        return false;
      await tx.emailVerificationChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      if (!(await verify(challenge.hash, dto.code))) return false;
      await tx.emailVerificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      return true;
    });
    if (!verified) throw new BadRequestException("Code is invalid or expired");
    return { verified: true };
  }
  // Retained for a future SMS provider; disconnected from active authentication routes.
  async sendOtp(phone: string) {
    await this.delivery.ensureSms();
    const code = String(randomInt(100000, 1000000));
    const challenge = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE phone=${phone} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { phone } });
      if (!user?.active || user.phoneVerified) return null;
      const recent = await tx.otpChallenge.count({
        where: { phone, createdAt: { gt: new Date(Date.now() - 3600000) } },
      });
      if (recent >= 5)
        throw new BadRequestException("Too many requests. Try again later.");
      const last = await tx.otpChallenge.findFirst({
        where: { phone },
        orderBy: { createdAt: "desc" },
      });
      if (last && Date.now() - last.createdAt.getTime() < 60000)
        throw new BadRequestException(
          "Wait a minute before requesting another code",
        );
      return tx.otpChallenge.create({
        data: {
          phone,
          hash: await hash(code),
          expiresAt: new Date(Date.now() + 300000),
        },
      });
    });
    if (!challenge)
      return { message: "If verification is needed, an OTP will be sent." };
    try {
      await this.delivery.sms(
        phone,
        `Your Roxodeal verification code is ${code}. It expires in 5 minutes.`,
      );
    } catch (e) {
      await this.db.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw e;
    }
    return { message: "If verification is needed, an OTP will be sent." };
  }
  async verifyOtp(dto: VerifyDto) {
    return this.db
      .$transaction(async (tx) => {
        const c = await tx.otpChallenge.findFirst({
          where: { phone: dto.phone, consumedAt: null },
          orderBy: { createdAt: "desc" },
        });
        if (!c) throw new BadRequestException("Code is invalid or expired");
        await tx.$queryRaw`SELECT id FROM "OtpChallenge" WHERE id=${c.id} FOR UPDATE`;
        const fresh = await tx.otpChallenge.findUniqueOrThrow({
          where: { id: c.id },
        });
        if (
          fresh.consumedAt ||
          fresh.expiresAt < new Date() ||
          fresh.attempts >= 5
        )
          return false;
        await tx.otpChallenge.update({
          where: { id: c.id },
          data: { attempts: { increment: 1 } },
        });
        if (!(await verify(fresh.hash, dto.code))) return false;
        await tx.otpChallenge.update({
          where: { id: c.id },
          data: { consumedAt: new Date() },
        });
        await tx.user.update({
          where: { phone: dto.phone },
          data: { phoneVerified: true },
        });
        return true;
      })
      .then((ok) => {
        if (!ok) throw new BadRequestException("Code is invalid or expired");
        return { verified: true };
      });
  }
  async forgot(email: string) {
    const user = await this.db.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (user) {
      const token = await this.jwt.signAsync(
        {
          sub: user.id,
          purpose: "PASSWORD_RESET",
          version: digest(user.passwordHash),
        },
        { expiresIn: "15m" },
      );
      const origin =
        user.role === "SELLER"
          ? process.env.SELLERS_URL || "http://localhost:3001"
          : user.role === "ADMIN"
            ? process.env.ADMIN_URL || "http://localhost:3002"
            : process.env.USERS_URL || "http://localhost:3000";
      const resetPath = user.role === "BUYER" ? "/reset-password" : "/login";
      await this.delivery.email(
        user.email,
        "Reset your Roxodeal password",
        `Reset your password: ${origin}${resetPath}?token=${encodeURIComponent(token)}`,
      );
    }
    return {
      message: "If this account exists, reset instructions have been sent.",
      resendAfter: 60,
    };
  }
  async reset(dto: ResetDto) {
    let p: any;
    try {
      p = await this.jwt.verifyAsync(dto.token);
    } catch {
      throw new BadRequestException("Reset link expired");
    }
    if (p.purpose !== "PASSWORD_RESET" || typeof p.sub !== "string")
      throw new BadRequestException("Reset link expired");
    const passwordHash = await hash(dto.password);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${p.sub} FOR UPDATE`;
      const u = await tx.user.findUnique({ where: { id: p.sub } });
      if (!u || p.version !== digest(u.passwordHash))
        throw new BadRequestException("Reset link expired");
      await tx.user.update({ where: { id: u.id }, data: { passwordHash } });
      await tx.authSession.updateMany({
        where: { userId: u.id },
        data: { revokedAt: new Date() },
      });
    });
    return { message: "Password reset. Sign in with your new password." };
  }
}
@Controller("auth")
export class LiveAuthController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(Db) private db: Db,
  ) {}
  @Public() @Post("register") register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }
  @Public() @Post("login") login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
  @Public() @Post("refresh") refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }
  @Public() @Post("email/send") sendEmail(@Body() dto: ForgotDto) {
    return this.auth.sendEmailVerification(dto.email);
  }
  @Public() @Post("email/verify") verifyEmail(@Body() dto: EmailVerifyDto) {
    return this.auth.verifyEmail(dto);
  }
  @Public() @Post("forgot-password") forgot(@Body() dto: ForgotDto) {
    return this.auth.forgot(dto.email);
  }
  @Public() @Post("reset-password") reset(@Body() dto: ResetDto) {
    return this.auth.reset(dto);
  }
  @Post("logout") async logout(@Req() req: any) {
    await this.db.authSession.updateMany({
      where: { userId: req.user.id, id: req.user.sessionId },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
  @Get("me") me(@Req() req: any) {
    return this.db.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        phoneVerified: true,
        emailVerified: true,
        company: true,
        city: true,
        address: true,
        state: true,
      },
    });
  }
}
