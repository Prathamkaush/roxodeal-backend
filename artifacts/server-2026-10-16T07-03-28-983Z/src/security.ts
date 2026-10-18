import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import { Db } from "./prisma";
export type Session = { id: string; role: Role; sessionId: string };
export const Public = () => SetMetadata("public", true);
export const Roles = (...roles: Role[]) => SetMetadata("roles", roles);
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private reflector: Reflector,
    @Inject(JwtService) private jwt: JwtService,
    @Inject(Db) private db: Db,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride("public", [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const req = context.switchToHttp().getRequest();
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new UnauthorizedException();
    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    const user = await this.db.user.findUnique({ where: { id: payload.sub } });
    if (!user?.active || !user.emailVerified) throw new UnauthorizedException();
    if (!payload.sid) throw new UnauthorizedException();
    const session = await this.db.authSession.findUnique({
      where: { id: payload.sid },
    });
    if (
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      session.expiresAt < new Date()
    )
      throw new UnauthorizedException();
    const roles = this.reflector.getAllAndOverride<Role[]>("roles", [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    req.user = { id: user.id, role: user.role, sessionId: payload.sid };
    return true;
  }
}
