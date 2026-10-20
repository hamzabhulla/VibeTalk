/**
 * Attachment MIME allowlist — SINGLE source of truth, shared by
 * the client upload gate (uploadAttachment in upload.ts) and the
 * server enforcement (sendMessage in chat.functions.ts).
 *
 * H11: server-side attachment MIME allowlist. The client controls
 * attachmentMeta.mime / type AND the object's stored content-type at
 * upload, so neither is trusted — the server decides what may be
 * attached. Dangerous types (HTML, SVG-with-script, executables,
 * scripts) are rejected outright. A lie about the CONTENT (HTML
 * labelled image/png) is harmless: the browser renders by
 * content-type, so it shows a broken image, never executes. Signed
 * URLs also force Content-Disposition: attachment (signAttachment),
 * so a slipped-through file downloads instead of executing.
 * Magic-byte sniffing adds no value here (the browser's content-type
 * handling is the enforcement point) and would require downloading
 * up to 1 GB inside a server fn.
 *
 * Audit-4 L12: the client gate MUST mirror this list exactly (same
 * Set + the octet-stream rule in isAllowedAttachmentMime). If the
 * two ever drift, the server remains the authority: a client-side
 * false rejection is a UX bug, a client-side false acceptance is
 * caught by the server — but the upload already happened, leaving
 * an orphaned object (the original L12 bug). Keep them in sync by
 * editing ONLY this file.
 */
export const ALLOWED_ATTACHMENT_MIMES = new Set([
  // Images (SVG excluded: it can carry scripts; opened in a new tab it
  // would execute in the storage domain).
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // Video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  // Audio
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/aac",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-tar",
]);

/**
 * The server rule (sendMessage): `application/octet-stream` is the
 * generic fallback the client legitimately produces for unknown file
 * types (empty File.type); it is served as a download-only
 * attachment (signAttachment), so it is allowed even though it is
 * not in the allowlist. An empty/missing MIME means the same
 * fallback will apply — allow it here too.
 */
export function isAllowedAttachmentMime(mime: string | undefined | null): boolean {
  if (!mime) return true;
  if (mime === "application/octet-stream") return true;
  return ALLOWED_ATTACHMENT_MIMES.has(mime);
}
