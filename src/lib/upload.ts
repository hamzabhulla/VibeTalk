import * as tus from "tus-js-client";
import { supabase } from "@/integrations/supabase/client";
import { isAllowedAttachmentMime } from "./attachment-mimes";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

// Audit-4 L66: fail fast with a clear error if the env is unset —
// the old code built `undefined/storage/v1/upload/resumable` and
// uploads failed obscurely. (client.ts throws the same way, but
// its Proxy is lazy, so this check is also the guard if the call
// order in the upload functions ever changes.)
function requireSupabaseUrl(): string {
  if (!SUPABASE_URL) {
    throw new Error(
      "Missing Supabase environment variable(s): SUPABASE_URL. Connect Supabase in Lovable Cloud.",
    );
  }
  return SUPABASE_URL;
}

export type UploadProgress = { percent: number; uploaded: number; total: number };

/**
 * Resumable upload to Supabase Storage using the tus protocol.
 * Supports resumable files up to 1 GB; chunks of 6MB. Uploads to <userId>/<roomId>/<uuid>-<filename>.
 */
export async function uploadAttachment(
  file: File,
  opts: { roomId: string; userId: string; onProgress?: (p: UploadProgress) => void },
): Promise<{ path: string; mime: string; size: number; name: string }> {
  if (file.size > 1024 * 1024 * 1024) {
    throw new Error("This file exceeds the 1 GB attachment limit.");
  }
  // Audit-4 L66: env validated before any work (see requireSupabaseUrl).
  const supabaseUrl = requireSupabaseUrl();
  // Audit-4 L12: MIME gate BEFORE any bytes upload — the server
  // (sendMessage) rejects disallowed types AFTER upload, which used
  // to leave an orphaned dangerous-type object in storage (HTML /
  // SVG / executable uploaded, send rejected, object orphaned). The
  // gate mirrors the server rule exactly (same allowlist +
  // octet-stream fallback — see attachment-mimes.ts), so nothing
  // the server would accept is rejected here; the server remains
  // the authority. The gate runs before the session fetch: a
  // disallowed file fails without touching the network.
  const mime = file.type || "application/octet-stream";
  if (!isAllowedAttachmentMime(mime)) {
    throw new Error("This file type is not allowed.");
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");

  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(0, 120);
  const path = `${opts.userId}/${opts.roomId}/${crypto.randomUUID()}-${safeName}`;

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "x-upsert": "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      // Audit-2 H10: resume MUST be keyed to THIS object. tus's default
      // fingerprint is (name, type, size, lastModified, endpoint) — it
      // knows nothing about the fresh per-call `path`, so retrying the
      // same file resumed the OLD upload (old objectName) while this
      // function returned the NEW path (an object never created) = a
      // message pointing at a dead attachment ("Attachment
      // unavailable"). Including `path` in the fingerprint makes a
      // resumed upload continue only the object this call will return;
      // a new attempt (new path) can never resume an old object.
      fingerprint: async (f) =>
        `vibetalk-upload:${path}:${f.name}:${f.size}:${f.lastModified}`,
      metadata: {
        bucketName: "chat-attachments",
        objectName: path,
        contentType: mime,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      onError: (err) => reject(err),
      onProgress: (uploaded, total) => {
        opts.onProgress?.({
          percent: total ? Math.round((uploaded / total) * 100) : 0,
          uploaded,
          total,
        });
      },
      onSuccess: () => resolve(),
    });

    upload
      .findPreviousUploads()
      .then((prev) => {
        if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
        upload.start();
      })
      .catch(() => upload.start());
  });

  return {
    path,
    mime,
    size: file.size,
    name: file.name,
  };
}

export function pickMessageType(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload a profile picture to <userId>/profile/ in the attachments bucket.
 * Returns the storage path to save on the profile.
 */
export async function uploadAvatar(
  file: File,
  userId: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<string> {
  // Audit-4 L66: env validated before any work (see requireSupabaseUrl).
  const supabaseUrl = requireSupabaseUrl();
  // Audit-2 M66: raster-only allowlist, matching the server-side
  // magic-byte check in updateProfile (assertValidAvatarFile). SVG is
  // rejected on both sides (a document format that can carry script).
  // This client check is UX only — the server re-validates the bytes.
  const AVATAR_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];
  if (!AVATAR_ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Please choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image (SVG is not supported).");
  }
  if (file.size > AVATAR_MAX_BYTES) throw new Error("Avatar must be under 5 MB.");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");

  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(0, 120);
  const path = `${userId}/profile/${crypto.randomUUID()}-${safeName}`;

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "x-upsert": "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      // Audit-2 H10: same as uploadAttachment — resume keyed to THIS
      // object (path in the fingerprint), so a retry of the same file
      // can never resume an old avatar object while returning a new
      // path (which would leave the profile pointing at a dead file).
      fingerprint: async (f) =>
        `vibetalk-upload:${path}:${f.name}:${f.size}:${f.lastModified}`,
      metadata: {
        bucketName: "chat-attachments",
        objectName: path,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      onError: (err) => reject(err),
      onProgress: (uploaded, total) => {
        onProgress?.({
          percent: total ? Math.round((uploaded / total) * 100) : 0,
          uploaded,
          total,
        });
      },
      onSuccess: () => resolve(),
    });

    upload
      .findPreviousUploads()
      .then((prev) => {
        if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
        upload.start();
      })
      .catch(() => upload.start());
  });

  return path;
}
