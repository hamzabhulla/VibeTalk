/**
 * M106: message-body size limits, shared by client (pre-send envelope
 * check) and server (zod backstop) so the two can never drift apart.
 *
 * The server caps stored bodies at 20_000 chars. A plaintext message
 * is at most 4_000 chars (composer maxLength), but an E2EE envelope
 * carries one wrapped key PER RECIPIENT — a 4_000-char message in a
 * ~50-member encrypted room produces an envelope over the cap. The
 * client checks the EXACT envelope before sending; the server keeps
 * the cap as a backstop with a friendly message.
 */
export const MESSAGE_BODY_MAX_LENGTH = 20_000;

export class MessageTooLongError extends Error {
  constructor(isE2EE: boolean) {
    super(
      isE2EE
        ? "This message is too long for this encrypted room — encrypted messages grow with each member. Shorten it and try again."
        : "This message is too long — shorten it and try again.",
    );
    this.name = "MessageTooLongError";
  }
}
