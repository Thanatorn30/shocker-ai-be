import crypto from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import { env, r2Enabled } from "../config/env.js";

// รูปบิล → ย่อ → Cloudflare R2 (bucket private)
// ดูรูป: ลิงก์ถาวรของเราเอง /api/receipts/:messageId/image?sig=... → ตรวจลายเซ็น → redirect ไป URL ของ R2 ที่หมดอายุใน 5 นาที

const MAX_SIDE = 1600; // px — ยังอ่านตัวเลขในบิลได้ ขนาดราว 150–300KB
const PRESIGN_SECONDS = 300;

let client: S3Client | undefined;

function r2(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey },
      // SDK รุ่นใหม่ใส่ checksum ทุก request โดยค่าเริ่มต้น — ส่งเฉพาะที่จำเป็นเพื่อให้เข้ากับ R2
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

/** ย่อรูป (หมุนตาม EXIF) → JPEG */
export async function shrinkImage(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

/** receipts/2026-11/<messageId>.jpg (เดือนตามเวลาไทย) */
function receiptKey(messageId: string, at: Date): string {
  const month = at.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 7);
  return `receipts/${month}/${messageId}.jpg`;
}

/** ย่อแล้วอัปโหลดไปที่ key — throw ถ้าไม่สำเร็จ (ลอง 2 ครั้ง) */
async function putShrunkImage(key: string, image: Buffer): Promise<void> {
  const body = await shrinkImage(image);
  for (let attempt = 1; ; attempt++) {
    try {
      await r2().send(new PutObjectCommand({ Bucket: env.r2.bucket, Key: key, Body: body, ContentType: "image/jpeg" }));
      console.log("[storage] uploaded", key, `${Math.round(body.length / 1024)}KB`);
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** ย่อแล้วอัปโหลด — คืน key ใน bucket หรือ null (ปิดฟีเจอร์/พัง) ไม่ throw, ลอง 2 ครั้ง */
export async function uploadReceiptImage(messageId: string, image: Buffer, at = new Date()): Promise<string | null> {
  if (!r2Enabled()) return null;
  try {
    const key = receiptKey(messageId, at);
    await putShrunkImage(key, image);
    return key;
  } catch (err) {
    console.error("[storage] upload failed", messageId, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * รูปที่อัปโหลดจากหน้าเว็บเข้าบิล → bills/2026-11/<billId>-<สุ่ม>.jpg
 * throw ถ้าไม่ใช่รูป/อัปโหลดไม่สำเร็จ (ผู้เรียกตอบ error ให้ผู้ใช้)
 */
export async function uploadBillImage(billId: string, image: Buffer): Promise<string> {
  if (!r2Enabled()) throw new Error("image storage not configured");
  const month = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 7);
  const key = `bills/${month}/${billId}-${crypto.randomBytes(6).toString("hex")}.jpg`;
  await putShrunkImage(key, image);
  return key;
}

/** ตรวจว่าไฟล์เป็นรูปที่ sharp อ่านได้ (กันไฟล์ปลอมนามสกุล) */
export async function isReadableImage(image: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(image).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}

/** ดึงไฟล์รูปจาก R2 (ใช้ส่งให้ AI อ่าน) */
export async function getImage(key: string): Promise<{ data: Buffer; mimeType: string }> {
  const res = await r2().send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
  if (!res.Body) throw new Error(`empty object: ${key}`);
  const data = Buffer.from(await res.Body.transformToByteArray());
  return { data, mimeType: res.ContentType ?? "image/jpeg" };
}

/** URL ชั่วคราว (5 นาที) สำหรับเปิดรูปใน R2 */
export async function presignImage(key: string): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }), {
    expiresIn: PRESIGN_SECONDS,
  });
}

// ───────────────────────── ลิงก์ถาวรแบบมีลายเซ็น ─────────────────────────

function sign(messageId: string): string {
  return crypto.createHmac("sha256", env.imageLinkSecret).update(messageId).digest("base64url").slice(0, 32);
}

export function verifyImageSig(messageId: string, sig: unknown): boolean {
  if (!env.imageLinkSecret || typeof sig !== "string") return false;
  const expected = Buffer.from(sign(messageId));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** ลิงก์ดูรูปที่ใช้ได้ตลอด (ใส่ในชีต) — null ถ้ายังไม่ได้ตั้ง PUBLIC_BASE_URL / IMAGE_LINK_SECRET */
export function receiptImageUrl(messageId: string): string | null {
  if (!env.publicBaseUrl || !env.imageLinkSecret) return null;
  return `${env.publicBaseUrl}/api/receipts/${messageId}/image?sig=${sign(messageId)}`;
}
