import { JWT } from "google-auth-library";
import { prisma } from "./prisma.js";
import { env, sheetsEnabled } from "../config/env.js";
import type { ReceiptData } from "./receipt.js";

// ผลอ่านใบเสร็จ (receipt_extractions.status = done) → ต่อแถวใน Google Sheet
// ใช้ Service Account: แชร์ชีตให้อีเมล GOOGLE_SA_EMAIL เป็น Editor ก่อน
// 1 ใบเสร็จ = 1 แถว (รายการสินค้ารวมไว้ในช่องเดียว)

export const SHEET_HEADER = [
  "message_id",
  "วันที่รับ",
  "ลูกค้า LINE",
  "ร้าน",
  "เลขที่ใบเสร็จ",
  "วันที่ใบเสร็จ",
  "ยอดก่อน VAT",
  "ส่วนลด",
  "VAT",
  "ยอดสุทธิ",
  "สกุลเงิน",
  "วิธีชำระ",
  "รายการ",
  "หมายเหตุ",
];
const LAST_COL = String.fromCharCode("A".charCodeAt(0) + SHEET_HEADER.length - 1); // N

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const RETRY_INTERVAL_MS = 5 * 60_000;
const RETRY_MIN_AGE_MS = 2 * 60_000; // ให้ตัวที่เพิ่งอ่านเสร็จส่งเองก่อน กันส่งซ้ำ

let client: JWT | undefined;
let headerChecked = false;

function auth(): JWT {
  if (!client) {
    client = new JWT({
      email: env.sheets.email,
      key: env.sheets.privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
  return client;
}

/** 'receipts'!A1:N1 — ครอบชื่อแท็บด้วย ' กันชื่อที่มีช่องว่าง/ภาษาไทย */
function range(cells: string): string {
  return `'${env.sheets.tab.replace(/'/g, "''")}'!${cells}`;
}

function url(path: string): string {
  return `${API}/${env.sheets.sheetId}/values/${encodeURIComponent(path)}`;
}

/** ถ้าแถว 1 ยังว่าง → ใส่หัวคอลัมน์ให้ (เช็คครั้งเดียวต่อการรัน server) */
async function ensureHeader(): Promise<void> {
  if (headerChecked) return;
  const res = await auth().request<{ values?: string[][] }>({ url: url(range(`A1:${LAST_COL}1`)) });
  if (!res.data.values?.[0]?.some((v) => v?.trim())) {
    await auth().request({
      url: `${url(range("A1"))}?valueInputOption=RAW`,
      method: "PUT",
      data: { values: [SHEET_HEADER] },
    });
  }
  headerChecked = true;
}

/** ต่อแถวท้ายตาราง — RAW: ข้อความจากรูปที่ขึ้นต้นด้วย = จะไม่กลายเป็นสูตร */
export async function appendRows(rows: (string | number | null)[][]): Promise<void> {
  await ensureHeader();
  await auth().request({
    url: `${url(range(`A:${LAST_COL}`))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: "POST",
    data: { values: rows },
  });
}

/** เวลาไทย "2026-11-24 14:35" */
function bangkokTime(date: Date): string {
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16);
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function receiptRow(messageId: string, receivedAt: Date, customer: string | null, d: ReceiptData) {
  const items = d.items
    .map((item, i) => {
      let line = `${i + 1}. ${item.name}`;
      if (item.quantity !== undefined) line += ` x${item.quantity}`;
      if (item.amount !== undefined) line += ` = ${item.amount}`;
      return line;
    })
    .join("\n");

  return [
    messageId,
    bangkokTime(receivedAt),
    customer,
    d.merchant_name ?? null,
    d.receipt_no ?? null,
    d.date ?? null,
    n(d.subtotal),
    n(d.discount),
    n(d.vat),
    n(d.total),
    d.currency ?? null,
    d.payment_method ?? null,
    items || null,
    d.notes ?? null,
  ];
}

/** ส่งผลอ่านใบเสร็จ 1 รายการเข้าชีต แล้วตั้ง sheet_synced_at — ไม่ throw */
export async function syncReceiptToSheet(messageId: string): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  const db = prisma();
  try {
    const row = await db.receiptExtraction.findUnique({
      where: { messageId },
      select: {
        status: true,
        data: true,
        sheetSyncedAt: true,
        message: {
          select: {
            createdAt: true,
            conversation: { select: { contact: { select: { displayName: true } } } },
          },
        },
      },
    });
    if (!row || row.status !== "done" || row.sheetSyncedAt || !row.data) return false;

    await appendRows([
      receiptRow(
        messageId,
        row.message.createdAt,
        row.message.conversation.contact.displayName,
        row.data as unknown as ReceiptData,
      ),
    ]);
    await db.receiptExtraction.update({ where: { messageId }, data: { sheetSyncedAt: new Date() } });
    console.log("[sheets] synced", messageId);
    return true;
  } catch (err) {
    console.error("[sheets] sync failed", messageId, err instanceof Error ? err.message : err);
    return false;
  }
}

/** ส่งซ้ำตัวที่อ่านเสร็จแต่ยังไม่เข้าชีต (Google ล่ม/env ยังไม่ได้ตั้งตอนนั้น) */
export async function syncPendingReceipts(): Promise<void> {
  if (!sheetsEnabled()) return;
  try {
    const pending = await prisma().receiptExtraction.findMany({
      where: { status: "done", sheetSyncedAt: null, updatedAt: { lt: new Date(Date.now() - RETRY_MIN_AGE_MS) } },
      select: { messageId: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const { messageId } of pending) await syncReceiptToSheet(messageId);
  } catch (err) {
    console.error("[sheets] pending sync failed", err instanceof Error ? err.message : err);
  }
}

/** เรียกตอน server start */
export function startSheetSync(): void {
  if (!sheetsEnabled()) {
    console.log("[sheets] disabled (GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY / GOOGLE_SHEET_ID not set)");
    return;
  }
  void syncPendingReceipts();
  setInterval(() => void syncPendingReceipts(), RETRY_INTERVAL_MS).unref();
}
