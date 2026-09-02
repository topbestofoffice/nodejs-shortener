export class AppError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly expose = true,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class MisdirectedRequestError extends AppError {
  public constructor() {
    super("Misdirected request.", 421, "MISDIRECTED_REQUEST");
  }
}

export class NotFoundError extends AppError {
  public constructor(message = "Not found.") {
    super(message, 404, "NOT_FOUND");
  }
}

export class TemporarilyUnavailableError extends AppError {
  public constructor() {
    super("Temporarily unavailable.", 503, "TEMPORARILY_UNAVAILABLE");
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, code = "VALIDATION_ERROR") {
    super(message, 400, code);
  }
}
