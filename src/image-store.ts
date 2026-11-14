export const IMAGE_LIMIT = 5 * 1024 * 1024;
const formats = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
export interface ImageStore {
  upload(file: File): Promise<string>;
  get(ref: string): Promise<Blob>;
}
export function imageKey(ref: string): string | null {
  return /^planner-image:\/\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/.test(
    ref,
  )
    ? ref.slice("planner-image://".length)
    : null;
}
export function isImageRef(ref: string): boolean {
  return !!imageKey(ref);
}
export function imageReferences(text: string): string[] {
  return [
    ...new Set(
      (text.match(/planner-image:\/\/[a-z0-9.-]+/g) || []).filter(isImageRef),
    ),
  ];
}
export async function validateImage(blob: Blob): Promise<string> {
  const ext = formats[blob.type as keyof typeof formats];
  if (!ext || !blob.size || blob.size > IMAGE_LIMIT)
    throw new Error("Choose a PNG, JPEG, WebP or GIF image up to 5 MB.");
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  const valid =
    ext === "png"
      ? bytes.slice(0, 8).join() === "137,80,78,71,13,10,26,10"
      : ext === "jpg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : ext === "webp"
          ? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
          : ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (!valid)
    throw new Error(
      "This file does not match its image format. Choose another image.",
    );
  return ext;
}
export async function validateStoredImage(ref: string, blob: Blob) {
  const key = imageKey(ref);
  if (!key || !key.endsWith(`.${await validateImage(blob)}`))
    throw new Error("Invalid image reference.");
}
export function imageAlt(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\[\]\\\r\n\x00-\x1f]/g, " ")
      .trim()
      .slice(0, 160) || "Image"
  );
}
