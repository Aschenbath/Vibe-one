export class ConsoleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.status = status;
  }
}
