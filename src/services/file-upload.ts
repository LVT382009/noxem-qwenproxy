/*
 * File: file-upload.ts
 * QwenProxy — File upload to Qwen's Aliyun OSS CDN.
 *
 * Flow:
 * 1. POST /api/v2/files/getstsToken → get OSS credentials + file_id
 * 2. PUT https://{bucket}.{endpoint}/{path} → upload file content
 * 3. Return QwenFile object for use in chat messages
 */

import { createHmac, createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getBasicHeaders } from "./playwright.ts";

const BASE_URL = "https://chat.qwen.ai";

// ── Types ──────────────────────────────────────────────────

export interface QwenFile {
  type: string; // "image" | "video" | "audio" | "file"
  file: {
    id: string;
    filename: string;
    user_id: string;
    created_at: number;
    update_at: number;
    data: Record<string, unknown>;
    hash: string | null;
    meta: { name: string; content_type: string; size: number };
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string; // "vision" | "document" | "video" | "audio"
  uploadTaskId: string;
}

export interface FileUploadResult {
  id: string;
  name: string;
  size: number;
  file_class: string;
  qwen_file: QwenFile;
}

interface StsTokenData {
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
  file_url: string;
  file_path: string;
  file_id: string;
  bucketname: string;
  region: string;
  endpoint: string;
}

// ── File type classification ───────────────────────────────

function getFileInfo(ext: string): {
  filetype: string;
  file_class: string;
  show_type: string;
  content_type: string;
} {
  const map: Record<
    string,
    { filetype: string; file_class: string; show_type: string; content_type: string }
  > = {
    jpg: { filetype: "image", file_class: "vision", show_type: "image", content_type: "image/jpeg" },
    jpeg: { filetype: "image", file_class: "vision", show_type: "image", content_type: "image/jpeg" },
    png: { filetype: "image", file_class: "vision", show_type: "image", content_type: "image/png" },
    gif: { filetype: "image", file_class: "vision", show_type: "image", content_type: "image/gif" },
    webp: { filetype: "image", file_class: "vision", show_type: "image", content_type: "image/webp" },
    mp4: { filetype: "video", file_class: "video", show_type: "file", content_type: "video/mp4" },
    mp3: { filetype: "audio", file_class: "audio", show_type: "file", content_type: "audio/mpeg" },
    wav: { filetype: "audio", file_class: "audio", show_type: "file", content_type: "audio/wav" },
    txt: { filetype: "file", file_class: "document", show_type: "file", content_type: "text/plain" },
    md: { filetype: "file", file_class: "document", show_type: "file", content_type: "text/markdown" },
    pdf: { filetype: "file", file_class: "document", show_type: "file", content_type: "application/pdf" },
    csv: { filetype: "file", file_class: "document", show_type: "file", content_type: "text/csv" },
    doc: { filetype: "file", file_class: "document", show_type: "file", content_type: "application/msword" },
    docx: { filetype: "file", file_class: "document", show_type: "file", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  };
  return (
    map[ext] || { filetype: "file", file_class: "document", show_type: "file", content_type: "application/octet-stream" }
  );
}

// ── Step 1: Get STS token from Qwen ────────────────────────

async function getStsToken(
  filename: string,
  filesize: number,
  filetype: string,
): Promise<StsTokenData> {
  const { cookie, userAgent, bxV } = await getBasicHeaders();

  const res = await fetch(`${BASE_URL}/api/v2/files/getstsToken`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      "user-agent": userAgent,
      "x-request-id": uuidv4(),
      "bx-v": bxV,
      origin: BASE_URL,
      referer: `${BASE_URL}/`,
    },
    body: JSON.stringify({ filename, filesize, filetype }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STS token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`STS token denied: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return json.data;
}

// ── Step 2: Upload to Aliyun OSS with V4 HMAC signing ──────

async function uploadToOss(
  sts: StsTokenData,
  fileData: Buffer,
  contentType: string,
): Promise<void> {
  const region = sts.region.startsWith("oss-") ? sts.region.slice(4) : sts.region;
  const ossUrl = `https://${sts.bucketname}.${sts.endpoint}/${sts.file_path}`;

  const ossDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
  const dateShort = ossDate.slice(0, 8);

  const credential = `${sts.access_key_id}/${dateShort}/${region}/oss/aliyun_v4_request`;
  const canonicalUri = `/${sts.bucketname}/${sts.file_path}`;
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `x-oss-content-sha256:UNSIGNED-PAYLOAD\n` +
    `x-oss-date:${ossDate}\n` +
    `x-oss-security-token:${sts.security_token}\n` +
    `x-oss-user-agent:aliyun-sdk-js/6.23.0 Chrome 142.0.0.0 on OS X 10.15.7 64-bit\n`;

  const canonicalRequest =
    `PUT\n${canonicalUri}\n\n${canonicalHeaders}\nUNSIGNED-PAYLOAD`;

  const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");

  const stringToSign =
    `OSS4-HMAC-SHA256\n${ossDate}\n${dateShort}/${region}/oss/aliyun_v4_request\n${requestHash}`;

  // Derive signing key
  const kDate = createHmac("sha256", `aliyun_v4${sts.access_key_secret}`)
    .update(dateShort)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("oss").digest();
  const kSigning = createHmac("sha256", kService).update("aliyun_v4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `OSS4-HMAC-SHA256 Credential=${credential},Signature=${signature}`;

  const ossRes = await fetch(ossUrl, {
    method: "PUT",
    headers: {
      authorization,
      "content-type": contentType,
      "x-oss-date": ossDate,
      "x-oss-security-token": sts.security_token,
      "x-oss-content-sha256": "UNSIGNED-PAYLOAD",
      "x-oss-user-agent": "aliyun-sdk-js/6.23.0 Chrome 142.0.0.0 on OS X 10.15.7 64-bit",
    },
    body: fileData,
  });

  if (!ossRes.ok) {
    const text = await ossRes.text().catch(() => "");
    throw new Error(`OSS upload failed (${ossRes.status}): ${text.slice(0, 300)}`);
  }
}

// ── Step 3: Build QwenFile object ──────────────────────────

function buildQwenFile(
  sts: StsTokenData,
  filename: string,
  filesize: number,
  fileInfo: { filetype: string; file_class: string; show_type: string; content_type: string },
  userId: string,
): QwenFile {
  const timestamp = Date.now();
  return {
    type: fileInfo.filetype,
    file: {
      id: sts.file_id,
      filename,
      user_id: userId,
      created_at: timestamp,
      update_at: timestamp,
      data: {},
      hash: null,
      meta: { name: filename, content_type: fileInfo.content_type, size: filesize },
    },
    id: sts.file_id,
    url: sts.file_url,
    name: filename,
    collection_name: "",
    progress: 0,
    status: "uploaded",
    greenNet: fileInfo.filetype === "video" ? "greening" : "success",
    size: filesize,
    error: "",
    itemId: uuidv4(),
    file_type: fileInfo.content_type,
    showType: fileInfo.show_type,
    file_class: fileInfo.file_class,
    uploadTaskId: uuidv4(),
  };
}

// ── Public API ─────────────────────────────────────────────

/**
 * Upload a file to Qwen's Aliyun OSS CDN.
 * Returns a QwenFile object suitable for inclusion in chat messages.
 */
export async function uploadFileToQwen(
  filename: string,
  fileData: Buffer,
  userId: string,
): Promise<FileUploadResult> {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const fileInfo = getFileInfo(ext);
  const filesize = fileData.length;

  // Step 1: Get STS token
  const sts = await getStsToken(filename, filesize, fileInfo.filetype);

  // Step 2: Upload to OSS
  await uploadToOss(sts, fileData, fileInfo.content_type);

  // Step 3: Build QwenFile
  const qwen_file = buildQwenFile(sts, filename, filesize, fileInfo, userId);

  return {
    id: sts.file_id,
    name: filename,
    size: filesize,
    file_class: fileInfo.file_class,
    qwen_file,
  };
}
