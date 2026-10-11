/**
 * Image pipeline (spec §58, §77, §109, §112).
 *
 * Handles an uploaded food photo safely: validates the real content type, enforces size and
 * dimension limits, strips metadata, produces a thumbnail, and derives a content hash used
 * to warn about accidental duplicate uploads.
 *
 * Security notes:
 *  - The declared MIME type and filename are NOT trusted. The actual format is detected
 *    from the file's own magic bytes, and a mismatch is rejected (spec §77).
 *  - Storage paths are generated randomly. A user-supplied filename is never used as a
 *    storage identifier, so path traversal and enumeration are not possible.
 *  - EXIF is dropped. Food photos routinely carry GPS coordinates, which the product has no
 *    use for and should not retain.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import sharp, { type Metadata } from 'sharp';

import { env } from '@/lib/env';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_DIMENSION = 4096;
export const MIN_DIMENSION = 64;
export const THUMBNAIL_SIZE = 320;

/** Formats we accept, with the magic bytes that identify each. */
const MAGIC_BYTES: { format: string; mime: string; test: (buf: Buffer) => boolean }[] = [
  {
    format: 'jpeg',
    mime: 'image/jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    format: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    format: 'webp',
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    format: 'gif',
    mime: 'image/gif',
    test: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF',
  },
  {
    format: 'heif',
    mime: 'image/heic',
    test: (b) => b.length > 12 && b.toString('ascii', 4, 12).includes('ftyphe'),
  },
];

export type ImageRejectionReason =
  | 'empty'
  | 'too_large'
  | 'unrecognised_format'
  | 'mime_mismatch'
  | 'dimensions_too_large'
  | 'dimensions_too_small'
  | 'corrupt';

export interface ImageRejection {
  readonly ok: false;
  readonly reason: ImageRejectionReason;
  readonly message: string;
  /** A recovery action the UI can offer (spec §92). */
  readonly recovery: string;
}

export interface ProcessedImage {
  readonly ok: true;
  readonly contentHash: string;
  readonly format: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  /** Random storage key without extension. The extension is derived from the format. */
  readonly storageKey: string;
  readonly storagePath: string;
  readonly thumbnailPath: string;
  readonly thumbnailBytes: number;
  /** Base64 of the compressed image, ready to send to a vision provider. */
  readonly base64: string;
}

export type ImageResult = ProcessedImage | ImageRejection;

export function detectFormat(buffer: Buffer): { format: string; mime: string } | null {
  for (const candidate of MAGIC_BYTES) {
    if (candidate.test(buffer)) return { format: candidate.format, mime: candidate.mime };
  }
  return null;
}

function reject(reason: ImageRejectionReason, message: string, recovery: string): ImageRejection {
  return { ok: false, reason, message, recovery };
}

/** Resolve the storage root, creating it on first use. */
async function storageRoot(): Promise<string> {
  const configured = env().STORAGE_DIR;
  const root = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Validate and normalise an uploaded food photo.
 *
 * @param buffer      raw uploaded bytes
 * @param declaredMime the Content-Type the client claimed (verified, not trusted)
 * @param maxBytes    optional override of the size ceiling
 */
export async function processFoodImage(params: {
  buffer: Buffer;
  declaredMime?: string | null;
  originalFilename?: string | null;
  maxBytes?: number;
}): Promise<ImageResult> {
  const maxBytes = params.maxBytes ?? Math.min(env().MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  const buffer = params.buffer;

  if (buffer.length === 0) {
    return reject('empty', 'The uploaded file was empty.', 'Choose a photo and try again.');
  }
  if (buffer.length > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    return reject(
      'too_large',
      `That image is larger than the ${mb} MB limit.`,
      'Choose a smaller photo, or take a new one at a lower resolution.',
    );
  }

  const detected = detectFormat(buffer);
  if (!detected) {
    return reject(
      'unrecognised_format',
      'That file is not a recognised image format.',
      'Upload a JPEG, PNG, WebP or HEIC photo.',
    );
  }

  // The declared type must agree with the real content. A mismatch is a red flag and is
  // refused rather than silently accepted (spec §77).
  if (params.declaredMime && params.declaredMime !== detected.mime) {
    // HEIC is commonly mislabelled by browsers; that single case is tolerated.
    const benignHeicCase =
      detected.format === 'heif' &&
      (params.declaredMime === 'image/heic' ||
        params.declaredMime === 'image/heif' ||
        params.declaredMime === 'application/octet-stream');
    if (!benignHeicCase) {
      return reject(
        'mime_mismatch',
        `The file claims to be ${params.declaredMime} but its contents are ${detected.mime}.`,
        'Upload the original photo without renaming or converting it.',
      );
    }
  }

  // Decode and inspect real dimensions.
  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    return reject(
      'corrupt',
      'That image could not be read; it may be damaged or incomplete.',
      'Try taking the photo again.',
    );
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    return reject(
      'dimensions_too_small',
      `That image is only ${width}×${height} px, which is too small to analyse.`,
      'Use a larger photo, at least 512 px on the shorter side.',
    );
  }
  if (width > MAX_DIMENSION * 2 || height > MAX_DIMENSION * 2) {
    return reject(
      'dimensions_too_large',
      `That image is ${width}×${height} px, which exceeds the supported size.`,
      'Resize the photo to below 8000 px on the longer side.',
    );
  }

  // Normalise: strip metadata, bound the dimensions, re-encode as JPEG for the model.
  // Deterministic output also means the hash below is stable for the same visual input.
  let normalised: Buffer;
  let finalWidth = width;
  let finalHeight = height;
  try {
    const pipeline = sharp(buffer, { failOn: 'error' })
      .rotate() // honour orientation, then discard the EXIF that carried it
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 84, mozjpeg: true });

    normalised = await pipeline.toBuffer();
    const outMeta = await sharp(normalised).metadata();
    finalWidth = outMeta.width ?? width;
    finalHeight = outMeta.height ?? height;
  } catch {
    return reject('corrupt', 'That image could not be processed.', 'Try taking the photo again.');
  }

  const thumbnail = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  // Content hash of the normalised bytes: two uploads of the same photo produce the same
  // hash, which drives the duplicate warning (spec §112).
  const contentHash = createHash('sha256').update(normalised).digest('hex');

  // Random storage key. Never derived from the user's filename.
  const storageKey = randomUUID();
  const root = await storageRoot();
  const imagePath = path.join(root, `${storageKey}.jpg`);
  const thumbPath = path.join(root, `${storageKey}.thumb.webp`);

  await writeFile(imagePath, normalised);
  await writeFile(thumbPath, thumbnail);

  return {
    ok: true,
    contentHash,
    format: 'jpeg',
    mimeType: 'image/jpeg',
    width: finalWidth,
    height: finalHeight,
    byteSize: normalised.length,
    storageKey,
    storagePath: imagePath,
    thumbnailPath: thumbPath,
    thumbnailBytes: thumbnail.length,
    base64: normalised.toString('base64'),
  };
}

/** Load a stored image as base64 for analysis. Ownership is checked by the caller. */
export async function readStoredImage(storagePath: string): Promise<Buffer> {
  return readFile(storagePath);
}

/** Remove a stored image, e.g. when a scan is deleted or the account is closed. */
export async function deleteStoredImage(storagePath: string | null): Promise<void> {
  if (!storagePath) return;
  try {
    await unlink(storagePath);
  } catch {
    // Already gone is not an error worth surfacing.
  }
}

/** Convert a byte count into a display string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
