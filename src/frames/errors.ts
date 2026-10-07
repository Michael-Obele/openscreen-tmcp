/**
 * A failure the model can act on. The message IS the tool output, so it must
 * name what was tried and what to do next — never a stack trace.
 */
export class FramesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramesError";
  }
}
