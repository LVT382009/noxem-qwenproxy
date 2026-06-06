/*
 * File: files.ts
 * QwenProxy — OpenAI-compatible file upload endpoint.
 *
 * POST /v1/files/upload
 * Accepts multipart form data with a "file" field.
 * Returns: { id, name, size, file_class, qwen_file }
 *
 * The returned qwen_file can be passed in the "files" array
 * of a chat completions request to attach the file to a message.
 */

import { Context } from "hono";
import { uploadFileToQwen, type QwenFile } from "../services/file-upload.ts";
import { getQwenHeaders } from "../services/playwright.ts";

// Size limit: 50 MiB per file
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function uploadFile(c: Context) {
  const contentType = c.req.header("content-type") || "";

  // Must be multipart
  if (!contentType.includes("multipart/form-data")) {
    return c.json(
      { error: { message: "Content-Type must be multipart/form-data", type: "invalid_request_error" } },
      400,
    );
  }

  try {
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || !(file instanceof File)) {
      return c.json(
        { error: { message: 'Missing "file" field in multipart form', type: "invalid_request_error" } },
        400,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        { error: { message: `File too large (${file.size} bytes, max ${MAX_FILE_SIZE})`, type: "invalid_request_error" } },
        400,
      );
    }

    // Get user_id from Qwen session headers
    let userId = "unknown";
    try {
      const { headers } = await getQwenHeaders();
      // Extract user_id from cookie or use a default
      // Qwen doesn't expose user_id directly in headers — the STS endpoint
      // associates the upload with the authenticated session automatically.
      // We pass a placeholder that gets overridden by the server.
      userId = "session_user";
    } catch {
      // Not authenticated — continue anyway, STS will fail if unauthenticated
    }

    const filename = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const fileData = Buffer.from(arrayBuffer);

    const result = await uploadFileToQwen(filename, fileData, userId);

    // Store for later retrieval via file_ids in chat requests
    storeUploadedFile(result.qwen_file);

    return c.json({
      id: result.id,
      object: "file",
      name: result.name,
      size: result.size,
      file_class: result.file_class,
      qwen_file: result.qwen_file,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[FileUpload] Error:", message);
    return c.json({ error: { message, type: "upload_error" } }, 500);
  }
}

/**
 * Extend chat completions to support file_ids in the request.
 * When file_ids are provided, fetch the corresponding QwenFile objects
 * and inject them into the QwenMessage's files array.
 */

// In-memory file store: file_id → QwenFile
const uploadedFiles = new Map<string, QwenFile>();

/** Store a QwenFile after upload for later reference in chat */
export function storeUploadedFile(qwenFile: QwenFile) {
  uploadedFiles.set(qwenFile.id, qwenFile);
}

/** Retrieve stored QwenFile objects by their IDs */
export function getUploadedFiles(fileIds: string[]): QwenFile[] {
  const files: QwenFile[] = [];
  for (const id of fileIds) {
    const f = uploadedFiles.get(id);
    if (f) files.push(f);
  }
  return files;
}
