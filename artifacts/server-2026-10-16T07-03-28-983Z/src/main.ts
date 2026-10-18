import "reflect-metadata";
import { getJwtSecret } from "./environment";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import { Db } from "./prisma";
import { RedisConnection } from "./redis";
import { MarketplaceService } from "./marketplace.service";
import { Payments } from "./payments";
import { SessionGuard } from "./security";
import { AuthService, LiveAuthController } from "./auth";
import { Delivery } from "./delivery";
import { WorkspaceController, WorkspaceService } from "./workspace";
import { ApiErrors } from "./http-errors";
import { AuthRateLimit } from "./rate-limit";
import { ApiRateLimit, ApiTrafficLimit } from "./api-rate-limit";
import { ReadCache } from "./read-cache";
import { Notices } from "./notices";
import { ReportsController } from "./reports";
import { CommunityController } from "./community";
import {
  MarketplaceController,
  FilesController,
  PaymentsController,
} from "./controllers";
const secret = getJwtSecret();
@Module({
  imports: [JwtModule.register({ secret, signOptions: { expiresIn: "1h" } })],
  controllers: [
    LiveAuthController,
    WorkspaceController,
    ReportsController,
    CommunityController,
    MarketplaceController,
    FilesController,
    PaymentsController,
  ],
  providers: [
    Db,
    RedisConnection,
    MarketplaceService,
    Payments,
    AuthService,
    Delivery,
    WorkspaceService,
    Notices,
    { provide: APP_GUARD, useClass: ApiTrafficLimit },
    { provide: APP_GUARD, useClass: AuthRateLimit },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: ApiRateLimit },
    { provide: APP_INTERCEPTOR, useClass: ReadCache },
  ],
})
class AppModule {}
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  if (process.env.TRUST_PROXY === "1")
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.setGlobalPrefix("api");
  app.use(helmet());
  app.useGlobalFilters(new ApiErrors());
  const origins = (
    process.env.WEB_ORIGINS ||
    process.env.WEB_ORIGIN ||
    "http://localhost:3000,http://localhost:3001,http://localhost:3002"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["Retry-After", "X-Cache"],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  const config = new DocumentBuilder()
    .setTitle("Roxodeal REST API")
    .setVersion("0.1")
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    "api/docs",
    app,
    SwaggerModule.createDocument(app, config),
  );
  await app.listen(Number(process.env.PORT || 4000), "0.0.0.0");
}
bootstrap();
