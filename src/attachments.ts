import { ApiError } from "./repository.js";
export const FILE_LIMIT = 3 * 1024 * 1024;
const types: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
};
export function fileKey(ref: string) {
  return /^planner-file:\/\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|txt|md|csv|zip|docx|xlsx|pptx)$/.test(
    ref,
  )
    ? ref.slice(15)
    : null;
}
export async function validateFile(blob: Blob) {
  const ext = types[blob.type];
  if (!ext || !blob.size || blob.size > FILE_LIMIT)
    throw new ApiError(
      422,
      "invalid_file",
      "Choose a PDF, text, Markdown, CSV, ZIP or Office file up to 3 MB.",
    );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const prefix = String.fromCharCode(...bytes.slice(0, 5));
  if (
    (ext === "pdf" && prefix !== "%PDF-") ||
    (["zip", "docx", "xlsx", "pptx"].includes(ext) &&
      !(bytes[0] === 80 && bytes[1] === 75)) ||
    (["txt", "md", "csv"].includes(ext) && bytes.includes(0))
  )
    throw new ApiError(
      422,
      "invalid_file",
      "File contents do not match the selected format.",
    );
  return ext;
}
