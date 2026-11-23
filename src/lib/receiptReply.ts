import crypto from "node:crypto";
import { prisma } from "./prisma.js";
import { pushMessage, replyMessage, startLoading, type PushResult } from "./line.js";
import { messagePreview } from "./messagePreview.js";
import { conversationInclude, messageInclude } from "./includes.js";
import { emitConversationUpdated, emitMessageCreated, emitMessageUpdated } from "./realtime.js";
import { extractReceipt, type ReceiptOutcome } from "./receipt.js";
import { env } from "../config/env.js";

// รูปที่ลูกค้าส่งมา → AI อ่านใบเสร็จ → ตอบสรุปกลับทาง LINE (และบันทึกเป็นข้อความ out ให้แอดมินเห็น)

export type ReceiptJob = {
  messageId: string; // messages.id ของรูป
  lineMessageId: string;
  lineUserId: string;
  replyToken?: string;
  sentAt: number; // event.timestamp (ms)
};

// replyToken หมดอายุเร็ว (LINE ไม่การันตีเวลา) — เกินนี้ไม่ลอง reply แล้วใช้ push เลย
const REPLY_TOKEN_MAX_AGE_MS = 50_000;
const MAX_TEXT = 5000; // LINE จำกัด text 5000 ตัวอักษร

// ───────────────────────── จัดรูปข้อความ ─────────────────────────

function money(n: number | undefined): string | undefined {
  return typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : undefined;
}

/** "2026-11-20" + "14:35" → "20 พ.ย. 2569 14:35 น." */
function formatDate(date?: string, time?: string): string | undefined {
  if (!date) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  const text =
    d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      : date;
  return time ? `${text} ${time} น.` : text;
}

export function formatReceiptReply(outcome: ReceiptOutcome): string {
  if (outcome.status === "failed") {
    return "ขออภัย ระบบอ่านใบเสร็จจากรูปนี้ไม่สำเร็จ กรุณาส่งรูปอีกครั้ง หรือรอเจ้าหน้าที่ตรวจสอบ";
  }
  if (outcome.status === "not_receipt") {
    return "ได้รับรูปแล้ว แต่ระบบไม่พบว่าเป็นใบเสร็จ หากเป็นใบเสร็จ กรุณาถ่ายให้เห็นทั้งใบและชัดขึ้น แล้วส่งอีกครั้ง";
  }

  const d = outcome.data;
  const currency = !d.currency || d.currency.toUpperCase() === "THB" ? "บาท" : d.currency.toUpperCase();
  const lines = ["🧾 อ่านใบเสร็จแล้ว"];

  if (d.merchant_name) lines.push(`ร้าน: ${d.merchant_name}`);
  const date = formatDate(d.date, d.time);
  if (date) lines.push(`วันที่: ${date}`);
  if (d.receipt_no) lines.push(`เลขที่: ${d.receipt_no}`);

  lines.push("", "รายการ");
  if (d.items.length === 0) lines.push("- (อ่านรายการไม่ออก)");
  d.items.forEach((item, i) => {
    let line = `${i + 1}. ${item.name}`;
    if (item.quantity !== undefined) line += ` x${item.quantity}`;
    const unit = money(item.unit_price);
    if (unit) line += ` @${unit}`;
    const amount = money(item.amount);
    if (amount) line += ` = ${amount}`;
    lines.push(line);
  });

  lines.push("");
  const discount = money(d.discount);
  if (discount && d.discount !== 0) lines.push(`ส่วนลด: ${discount}`);
  const vat = money(d.vat);
  if (vat) lines.push(`VAT: ${vat}`);
  lines.push(`ยอดสุทธิ: ${money(d.total) ?? "-"} ${currency}`);
  if (d.notes) lines.push("", `หมายเหตุ: ${d.notes}`);

  const text = lines.join("\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

// ───────────────────────── ส่งกลับ LINE ─────────────────────────

/** บันทึกข้อความ out (บอท) → ส่ง reply (ฟรี) ถ้า token ยังใหม่ ไม่งั้น/พัง → push */
async function sendBotText(job: ReceiptJob, text: string): Promise<void> {
  const db = prisma();
  const inbound = await db.message.findUnique({
    where: { id: job.messageId },
    select: { conversationId: true, conversation: { select: { contact: { select: { isFollowing: true } } } } },
  });
  if (!inbound || !inbound.conversation.contact.isFollowing) return; // ลูกค้าบล็อก OA → ส่งไม่ได้

  const conversationId = inbound.conversationId;
  const retryKey = crypto.randomUUID();
  const { created, conversation } = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        conversationId,
        direction: "out", // senderAdminId = null → บอทส่ง
        type: "text",
        text,
        payload: { bot: "receipt", replyTo: job.messageId },
        retryKey,
        sendStatus: "queued",
      },
      include: messageInclude,
    });
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: created.createdAt, lastMessagePreview: messagePreview("text", text) },
      include: conversationInclude,
    });
    return { created, conversation };
  });
  emitMessageCreated(conversationId, created);
  emitConversationUpdated(conversation);

  const messages = [{ type: "text", text }];
  let result: PushResult | undefined;
  if (job.replyToken && Date.now() - job.sentAt < REPLY_TOKEN_MAX_AGE_MS) {
    result = await replyMessage(job.replyToken, messages);
    if (!result.ok) console.warn("[receipt] reply failed, fallback to push", result.status, result.error);
  }
  if (!result?.ok) result = await pushMessage(job.lineUserId, messages, retryKey);

  const updated = await db.message.update({
    where: { id: created.id },
    data: result.ok
      ? { sendStatus: "sent", sendError: null, lineMessageId: result.sentMessageIds[0] ?? undefined }
      : { sendStatus: "failed", sendError: `${result.status}: ${result.error}`.slice(0, 2000) },
    include: messageInclude,
  });
  emitMessageUpdated(conversationId, updated);
}

/** entry point จาก webhook (หลังตอบ 200) — ไม่ throw */
export async function handleReceiptImage(job: ReceiptJob): Promise<void> {
  // จุด ... กำลังพิมพ์ ในแชตลูกค้าระหว่างรอ AI (หายเองเมื่อบอทตอบ) — พังไม่เป็นไร
  if (env.receiptAutoReply) void startLoading(job.lineUserId, 60);

  const outcome = await extractReceipt(job.messageId, job.lineMessageId);
  if (!outcome || !env.receiptAutoReply) return;

  try {
    await sendBotText(job, formatReceiptReply(outcome));
  } catch (err) {
    console.error("[receipt] send reply failed", job.messageId, err);
  }
}
