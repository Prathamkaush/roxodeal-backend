import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    res.setHeader("Cache-Control", "no-store");
    if (error instanceof HttpException) {
      const detail = error.getResponse();
      if (
        error.getStatus() === 429 &&
        typeof detail === "object" &&
        "retryAfter" in detail
      )
        res.setHeader("Retry-After", String(detail.retryAfter));
      return res.status(error.getStatus()).json(error.getResponse());
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const status =
        error.code === "P2002" ? 409 : error.code === "P2025" ? 404 : 400;
      return res.status(status).json({
        statusCode: status,
        message:
          status === 409
            ? "This record already exists"
            : status === 404
              ? "Record not found"
              : "Invalid record reference or value",
      });
    }
    return res.status(500).json({
      statusCode: 500,
      message: "An unexpected server error occurred",
    });
  }
}
