export class ApplicationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 415 | 429 | 503) {
    super(message);
    this.name = "ApplicationError";
  }
}
