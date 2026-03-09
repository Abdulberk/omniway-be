import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
    param?: string;
  };
  request_id?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const requestId = (request.headers['x-request-id'] as string) || request.id;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorType: string | undefined;
    let errorCode: string | undefined;
    let param: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;

        if (
          typeof resp.error === 'object' &&
          resp.error !== null &&
          !Array.isArray(resp.error)
        ) {
          const nestedError = resp.error as Record<string, unknown>;
          message =
            (nestedError.message as string) ||
            this.getMessageFromResponse(resp.message) ||
            message;
          errorType =
            (nestedError.type as string) || (resp.type as string) || errorType;
          errorCode =
            (nestedError.code as string) || (resp.code as string) || errorCode;
          param = (nestedError.param as string) || undefined;
        } else {
          message = this.getMessageFromResponse(resp.message) || message;
          errorType = (resp.type as string) || errorType;
          errorCode = (resp.code as string) || errorCode;
        }
      }

      errorType ??= this.getErrorType(status);
      errorCode ??= this.getErrorCode(status);
    } else if (exception instanceof Error) {
      message = exception.message;
      errorType = this.getErrorType(status);
      errorCode = this.getErrorCode(status);

      // Log unexpected errors
      this.logger.error(`Unexpected error: ${message}`, exception.stack, {
        requestId,
      });
    }

    // OpenAI-compatible error format
    const errorResponse: ErrorResponse = {
      error: {
        message,
        type: errorType || this.getErrorType(status),
        code: errorCode || this.getErrorCode(status),
        param,
      },
      request_id: requestId,
    };

    // Log the error
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status} - ${message}`,
        { requestId, status, errorType },
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} ${status} - ${message}`,
        { requestId, status, errorType },
      );
    }

    response.status(status).send(errorResponse);
  }

  private getMessageFromResponse(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value) && value.length > 0) {
      return value.join(', ');
    }

    return undefined;
  }

  private getErrorType(status: number): string {
    switch (status) {
      case 400:
        return 'invalid_request_error';
      case 401:
        return 'authentication_error';
      case 403:
        return 'permission_error';
      case 404:
        return 'not_found_error';
      case 409:
        return 'conflict_error';
      case 422:
        return 'invalid_request_error';
      case 429:
        return 'rate_limit_error';
      case 402:
        return 'billing_error';
      case 503:
        return 'service_unavailable_error';
      default:
        return status >= 500 ? 'api_error' : 'invalid_request_error';
    }
  }

  private getErrorCode(status: number): string {
    switch (status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'invalid_api_key';
      case 403:
        return 'insufficient_permissions';
      case 404:
        return 'not_found';
      case 409:
        return 'conflict';
      case 422:
        return 'unprocessable_entity';
      case 429:
        return 'rate_limit_exceeded';
      case 402:
        return 'insufficient_quota';
      case 503:
        return 'service_unavailable';
      default:
        return status >= 500 ? 'internal_error' : 'bad_request';
    }
  }
}
