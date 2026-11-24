import { Prisma } from "@prisma/client";
import { ApiError } from "@google/genai";
import { prisma } from "./prisma.js";
import { gemini } from "./gemini.js";
import { getMessageContent } from "./line.js";
import { env } from "../config/env.js";
import { syncReceiptToSheet } from "./sheets.js";

// อ่านใบเสร็จจากรูปที่ลูกค้าส่งมาทาง LINE ด้วย Gemini → JSON → receipt_extractions
// ไม่เก็บตัวรูป: ดึงจาก LINE มาเป็น Buffer ในหน่วยความจำ ส่งให้ AI แล้วทิ้ง

// ───────────────────────── รูปแบบ JSON ที่ให้ AI ตอบ ─────────────────────────

export interface ReceiptItem {
  name: string;
  quantity?: number;
  unit_price?: number;
  amount?: number;
}

export interface ReceiptData {
  is_receipt: boolean;
  document_type?: string;
  merchant_name?: string;
  merchant_branch?: string;
  merchant_tax_id?: string;
  merchant_address?: string;
  receipt_no?: string;
  date?: string; // YYYY-MM-DD ปี ค.ศ.
  time?: string; // HH:MM
  items: ReceiptItem[];
  subtotal?: number;
  discount?: number;
  service_charge?: number;
  vat?: number;
  total?: number;
  currency?: string;
  payment_method?: string;
  notes?: string;
}

const num = { type: "number" } as const;
const str = { type: "string" } as const;

/** JSON Schema ให้ Gemini ตอบตามนี้เสมอ — ช่องที่ไม่ required = อ่านไม่ออก/ไม่มีในรูปให้ละไว้ */
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean", description: "รูปนี้เป็นใบเสร็จ/ใบกำกับภาษี/บิลซื้อขายหรือไม่" },
    document_type: {
      type: "string",
      enum: ["receipt", "tax_invoice", "abbreviated_tax_invoice", "invoice", "transfer_slip", "other"],
    },
    merchant_name: { ...str, description: "ชื่อร้าน/บริษัทผู้ขาย" },
    merchant_branch: { ...str, description: "สาขา เช่น สำนักงานใหญ่ หรือ สาขาที่ 00012" },
    merchant_tax_id: { ...str, description: "เลขประจำตัวผู้เสียภาษี 13 หลัก ตัวเลขล้วน" },
    merchant_address: str,
    receipt_no: { ...str, description: "เลขที่ใบเสร็จ/เลขที่เอกสาร" },
    date: { ...str, description: "วันที่ในเอกสาร รูปแบบ YYYY-MM-DD ปี ค.ศ. (ถ้าเป็น พ.ศ. ให้ลบ 543)" },
    time: { ...str, description: "เวลา HH:MM แบบ 24 ชม." },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: str, quantity: num, unit_price: num, amount: num },
        required: ["name"],
      },
    },
    subtotal: num,
    discount: num,
    service_charge: num,
    vat: num,
    total: { ...num, description: "ยอดสุทธิที่ต้องจ่าย" },
    currency: { ...str, description: "รหัสสกุลเงิน ISO 4217 เช่น THB" },
    payment_method: { ...str, description: "เช่น cash, credit_card, qr, transfer" },
    notes: { ...str, description: "สิ่งที่อ่านไม่ชัด/ไม่แน่ใจ" },
  },
  required: ["is_receipt", "items"],
};

const PROMPT = `อ่านรูปนี้แล้วถอดข้อมูลใบเสร็จเป็น JSON ตาม schema
- ถ้าไม่ใช่ใบเสร็จ/บิล ให้ is_receipt = false และ items = []
- ตัวเลขเงินเป็น number ไม่มีคอมมาหรือสัญลักษณ์สกุลเงิน
- ห้ามเดา: ช่องที่ไม่มีในรูปหรืออ่านไม่ออกให้ละไว้ แล้วระบุใน notes
- วันที่ในใบเสร็จไทยมักเป็น พ.ศ. ให้แปลงเป็น ค.ศ.`;

// ───────────────────────── helpers ─────────────────────────

/** YYYY-MM-DD → Date (ถ้ารูปแบบผิด/ยังเป็น พ.ศ. → null) */
function toDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 2000 || year > 2100 ? null : date;
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  return typeof value === "number" && Number.isFinite(value) ? new Prisma.Decimal(value.toFixed(2)) : null;
}

function clip(value: string | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}

/** ส่งรูปให้โมเดลเดียวอ่าน → ReceiptData */
async function readWithModel(model: string, image: Buffer, mimeType: string): Promise<ReceiptData> {
  const response = await gemini().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType, data: image.toString("base64") } }, { text: PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: RECEIPT_SCHEMA,
      // ค่าเริ่มต้นของ SDK = ไม่มี timeout + retry 5 ครั้ง (รอสูงสุด 60 วิ/ครั้ง) → ค้างได้หลายนาที
      // ลองโมเดลละครั้ง แล้วไปโมเดลถัดไปเลย (ช่วงคนใช้เยอะ โมเดลใหม่สุดมักตอบ 503/504)
      httpOptions: { timeout: 45_000, retryOptions: { attempts: 1 } },
    },
  });

  const text = response.text;
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason;
    throw new Error(`gemini returned no text (${reason ?? "unknown"})`);
  }

  const data = JSON.parse(text) as ReceiptData;
  if (typeof data.is_receipt !== "boolean") throw new Error("gemini response missing is_receipt");
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

/** error ที่ควรลองโมเดลถัดไป: คนใช้เยอะ/ล่ม/โมเดลถูกถอด/timeout/เน็ต */
function shouldTryNextModel(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 404 || err.status === 429 || err.status >= 500;
  return !(err instanceof SyntaxError); // JSON พัง = ปัญหาคำตอบ ไม่ใช่โมเดลล่ม
}

/** ส่งรูปให้ Gemini อ่าน — ลองโมเดลตามลำดับใน env.gemini.models */
export async function readReceiptImage(
  image: Buffer,
  mimeType: string,
): Promise<{ data: ReceiptData; model: string }> {
  let lastError: unknown = new Error("no GEMINI_MODELS configured");
  for (const model of env.gemini.models) {
    try {
      return { data: await readWithModel(model, image, mimeType), model };
    } catch (err) {
      lastError = err;
      if (!shouldTryNextModel(err)) break;
      console.warn("[receipt] model failed, trying next", model, err instanceof Error ? err.message : err);
    }
  }
  throw lastError;
}

// ───────────────────────── entry point ─────────────────────────

export type ReceiptOutcome =
  | { status: "done" | "not_receipt"; data: ReceiptData }
  | { status: "failed"; error: string };

/**
 * อ่านใบเสร็จจากรูปของข้อความ (messages.id) แล้วบันทึกลง receipt_extractions
 * ไม่ throw (ผิดพลาด = status failed + error) — คืน null = เคยอ่านแล้ว/กำลังอ่าน/เริ่มไม่ได้ (ไม่ต้องตอบลูกค้าซ้ำ)
 */
export async function extractReceipt(
  messageId: string,
  lineMessageId: string,
  options: { syncSheet?: boolean } = {},
): Promise<ReceiptOutcome | null> {
  const db = prisma();

  try {
    const existing = await db.receiptExtraction.findUnique({
      where: { messageId },
      select: { status: true },
    });
    if (existing && existing.status !== "failed") return null; // อ่านแล้ว/กำลังอ่านอยู่

    await db.receiptExtraction.upsert({
      where: { messageId },
      create: { messageId, status: "processing", attempts: 1 },
      update: { status: "processing", error: null, attempts: { increment: 1 } },
    });
  } catch (err) {
    console.error("[receipt] start failed", messageId, err);
    return null;
  }

  try {
    const { contentType, body } = await getMessageContent(lineMessageId);
    if (!contentType.startsWith("image/")) throw new Error(`not an image: ${contentType}`);

    const { data, model } = await readReceiptImage(body, contentType);

    await db.receiptExtraction.update({
      where: { messageId },
      data: {
        status: data.is_receipt ? "done" : "not_receipt",
        model,
        data: data as unknown as Prisma.InputJsonValue,
        merchantName: clip(data.merchant_name, 255),
        receiptNo: clip(data.receipt_no, 100),
        receiptDate: toDate(data.date),
        totalAmount: toDecimal(data.total),
        currency: clip(data.currency, 3)?.toUpperCase() ?? null,
        error: null,
      },
    });
    console.log("[receipt]", data.is_receipt ? "done" : "not_receipt", messageId);
    // ส่งเข้า Google Sheet แบบไม่รอ (ไม่ให้ช้า/พังแล้วกระทบการตอบลูกค้า) — พลาดจะมีรอบส่งซ้ำใน sheets.ts
    // รูปที่มาเป็นชุด (imageSet) → ผู้เรียกจะเขียนชีตทีเดียวหลังอ่านครบ (syncSheet: false)
    if (data.is_receipt && options.syncSheet !== false) void syncReceiptToSheet(messageId);
    return { status: data.is_receipt ? "done" : "not_receipt", data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[receipt] extract failed", messageId, err);
    await db.receiptExtraction
      .update({ where: { messageId }, data: { status: "failed", error: message.slice(0, 2000) } })
      .catch((e) => console.error("[receipt] mark failed error", e));
    return { status: "failed", error: message };
  }
}
