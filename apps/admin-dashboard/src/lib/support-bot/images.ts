// Screenshots attached to a support bot question (lib/support-bot). PURE.
//
// The page shrinks a picture before sending it (longest side 1600 px, JPEG), so a normal phone
// screenshot arrives well under the limit here. What arrives is checked by its bytes, not by the
// type the browser claimed: a file that is not really an image is refused.

import type { BotImage, BotImageType } from "@/lib/support-bot/bot";

export const MAX_IMAGES = 3;
/** Per image, decoded. The model takes up to 5 MB of base64 per image. */
export const MAX_IMAGE_BYTES = 3_500_000;

const SIGNATURES: [BotImageType, (b: Buffer) => boolean][] = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** The type of an image by its first bytes, or null when it is not one we take. */
export function sniffImage(b: Buffer): BotImageType | null {
  return SIGNATURES.find(([, is]) => b.length >= 12 && is(b))?.[0] ?? null;
}

/**
 * Read the images of a request: a data URL ("data:image/jpeg;base64,…") or bare base64 each.
 * Returns the images, or the reason they are refused.
 */
export function readImages(input: unknown): { images: BotImage[] } | { error: string } {
  if (input === undefined || input === null) return { images: [] };
  if (!Array.isArray(input)) return { error: "images must be a list" };
  if (input.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} screenshots at a time.` };
  const images: BotImage[] = [];
  for (const raw of input) {
    const s = typeof raw === "string" ? raw.replace(/^data:[^;,]*;base64,/, "") : "";
    if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return { error: "A screenshot could not be read." };
    const bytes = Buffer.from(s, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) return { error: "A screenshot is too large. Please send a smaller one." };
    const type = sniffImage(bytes);
    if (!type) return { error: "Only pictures (JPG, PNG, WebP or GIF) can be attached." };
    images.push({ media_type: type, data: bytes.toString("base64") });
  }
  return { images };
}
