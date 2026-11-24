import crypto from "node:crypto";
import { prisma } from "./prisma.js";
import { pushMessage, replyMessage, startLoading, type PushResult } from "./line.js";
import { messagePreview } from "./messagePreview.js";
import { conversationInclude, messageInclude } from "./includes.js";
import { emitConversationUpdated, emitMessageCreated, emitMessageUpdated } from "./realtime.js";
import { extractReceipt, type ReceiptData, type ReceiptOutcome } from "./receipt.js";
import { syncReceiptsToSheet } from "./sheets.js";
import { env } from "../config/env.js";

// รูปที่ลูกค้าส่งมา → AI อ่านใบเสร็จ → ตอบสรุปกลับทาง LINE (และบันทึกเป็นข้อความ out ให้แอดมินเห็น)

export type ReceiptJob = {
  messageId: string; // messages.id ของรูป
  lineMessageId: string;
  lineUserId: string;
  replyToken?: string;
  sentAt: number; // event.timestamp (ms)
  imageSet?: { id: string; index: number; total: number };
};

// replyToken หมดอายุเร็ว (LINE ไม่การันตีเวลา) — เกินนี้ไม่ลอง reply แล้วใช้ push เลย
const REPLY_TOKEN_MAX_AGE_MS = 50_000;
const MAX_TEXT = 5000; // LINE จำกัด text 5000 ตัวอักษร
const MAX_MESSAGES = 5; // LINE reply/push ได้ครั้งละไม่เกิน 5 ข้อความ
// รูปที่ส่งมาเป็นชุด (imageSet) อาจมาคนละ webhook — รอรูปที่เหลือไม่เกินเท่านี้นับจากรูปล่าสุด
const IMAGE_SET_WAIT_MS = 20_000;

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

function clipText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

const isBaht = (currency?: string) => !currency || currency.toUpperCase() === "THB";

export function formatReceiptReply(outcome: ReceiptOutcome): string {
  if (outcome.status === "failed") {
    return "ขออภัย ระบบอ่านใบเสร็จจากรูปนี้ไม่สำเร็จ กรุณาส่งรูปอีกครั้ง หรือรอเจ้าหน้าที่ตรวจสอบ";
  }
  if (outcome.status === "not_receipt") {
    return "ได้รับรูปแล้ว แต่ระบบไม่พบว่าเป็นใบเสร็จ หากเป็นใบเสร็จ กรุณาถ่ายให้เห็นทั้งใบและชัดขึ้น แล้วส่งอีกครั้ง";
  }
  return clipText(["🧾 อ่านใบเสร็จแล้ว", ...receiptLines(outcome.data)].join("\n"));
}

/** รายละเอียดใบเสร็จ 1 ใบ (ไม่มีหัวข้อ) */
function receiptLines(d: ReceiptData): string[] {
  const currency = isBaht(d.currency) ? "บาท" : d.currency!.toUpperCase();
  const lines: string[] = [];

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
  return lines;
}

/**
 * หลายใบในชุดเดียว → ข้อความสรุปรวม (แบ่งเป็นหลาย bubble ถ้ายาวเกิน 5,000 ตัวอักษร, สูงสุด 5 bubble ต่อการตอบ)
 * outcomes เรียงตามลำดับรูป
 */
export function formatReceiptSetReply(outcomes: ReceiptOutcome[]): string[] {
  const done = outcomes.filter(
    (o): o is Extract<ReceiptOutcome, { data: ReceiptData }> => o.status === "done",
  );
  const blocks = [`🧾 อ่านใบเสร็จ ${outcomes.length} ใบ (สำเร็จ ${done.length} ใบ)`];

  outcomes.forEach((o, i) => {
    const title = `━━ ใบที่ ${i + 1} ━━`;
    if (o.status === "failed") blocks.push(`${title}\n❌ อ่านไม่สำเร็จ กรุณาส่งรูปนี้อีกครั้ง`);
    else if (o.status === "not_receipt") blocks.push(`${title}\n⚠️ ไม่พบว่าเป็นใบเสร็จ`);
    else blocks.push(clipText([title, ...receiptLines(o.data)].join("\n")));
  });

  // รวมยอดเฉพาะเมื่อทุกใบที่อ่านได้เป็นเงินบาทและมียอดสุทธิ
  if (done.length >= 2 && done.every((o) => isBaht(o.data.currency) && typeof o.data.total === "number")) {
    const sum = done.reduce((s, o) => s + (o.data.total as number), 0);
    blocks.push(`💰 รวมยอดสุทธิ ${done.length} ใบ: ${money(sum)} บาท`);
  }

  // รวม block เป็น bubble ละไม่เกิน MAX_TEXT
  const texts: string[] = [];
  for (const block of blocks) {
    const last = texts.length - 1;
    if (last >= 0 && texts[last].length + 2 + block.length <= MAX_TEXT) texts[last] += `\n\n${block}`;
    else texts.push(block);
  }
  if (texts.length > MAX_MESSAGES) {
    const rest = texts.length - (MAX_MESSAGES - 1);
    return [...texts.slice(0, MAX_MESSAGES - 1), `...และรายละเอียดอีก ${rest} ส่วน (บันทึกครบทุกใบแล้ว)`];
  }
  return texts;
}

// ───────────────────────── ส่งกลับ LINE ─────────────────────────

/**
 * บันทึกข้อความ out (บอท) → ส่งทุกข้อความในการตอบครั้งเดียว: reply (ฟรี) ถ้า token ยังใหม่ ไม่งั้น/พัง → push
 * job = รูปที่ใช้ replyToken/อ้างอิง (ชุดหลายรูปใช้รูปล่าสุด)
 */
async function sendBotTexts(job: ReceiptJob, texts: string[], replyTo: string[] = [job.messageId]): Promise<void> {
  texts = texts.slice(0, MAX_MESSAGES);
  if (texts.length === 0) return;
  const db = prisma();
  const inbound = await db.message.findUnique({
    where: { id: job.messageId },
    select: { conversationId: true, conversation: { select: { contact: { select: { isFollowing: true } } } } },
  });
  if (!inbound || !inbound.conversation.contact.isFollowing) return; // ลูกค้าบล็อก OA → ส่งไม่ได้

  const conversationId = inbound.conversationId;
  const retryKey = crypto.randomUUID(); // push ทั้งชุดใช้ key เดียว (ข้อความแรกเก็บ key ไว้)
  const { created, conversation } = await db.$transaction(async (tx) => {
    const created = [];
    for (const [i, text] of texts.entries()) {
      created.push(
        await tx.message.create({
          data: {
            conversationId,
            direction: "out", // senderAdminId = null → บอทส่ง
            type: "text",
            text,
            payload: { bot: "receipt", replyTo: replyTo.length === 1 ? replyTo[0] : replyTo },
            retryKey: i === 0 ? retryKey : crypto.randomUUID(),
            sendStatus: "queued",
          },
          include: messageInclude,
        }),
      );
    }
    const lastCreated = created[created.length - 1];
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: lastCreated.createdAt,
        lastMessagePreview: messagePreview("text", texts[texts.length - 1]),
      },
      include: conversationInclude,
    });
    return { created, conversation };
  });
  for (const m of created) emitMessageCreated(conversationId, m);
  emitConversationUpdated(conversation);

  const messages = texts.map((text) => ({ type: "text", text }));
  let result: PushResult | undefined;
  if (job.replyToken && Date.now() - job.sentAt < REPLY_TOKEN_MAX_AGE_MS) {
    result = await replyMessage(job.replyToken, messages);
    if (!result.ok) console.warn("[receipt] reply failed, fallback to push", result.status, result.error);
  }
  if (!result?.ok) result = await pushMessage(job.lineUserId, messages, retryKey);

  for (const [i, m] of created.entries()) {
    const updated = await db.message.update({
      where: { id: m.id },
      data: result.ok
        ? { sendStatus: "sent", sendError: null, lineMessageId: result.sentMessageIds[i] ?? undefined }
        : { sendStatus: "failed", sendError: `${result.status}: ${result.error}`.slice(0, 2000) },
      include: messageInclude,
    });
    emitMessageUpdated(conversationId, updated);
  }
}

// ───────────────────────── รูปที่ส่งมาเป็นชุด ─────────────────────────

// เก็บในหน่วยความจำ (server ตัวเดียว) — รูปในชุดเดียวกันอาจมาคนละ webhook
type PendingSet = { total: number; jobs: ReceiptJob[]; timer: NodeJS.Timeout };
const pendingSets = new Map<string, PendingSet>();

function queueImageSet(job: ReceiptJob & { imageSet: NonNullable<ReceiptJob["imageSet"]> }): void {
  const key = `${job.lineUserId}:${job.imageSet.id}`;
  let set = pendingSets.get(key);
  if (!set) {
    set = { total: job.imageSet.total, jobs: [], timer: setTimeout(() => {}, 0) };
    pendingSets.set(key, set);
  }
  if (!set.jobs.some((j) => j.messageId === job.messageId)) set.jobs.push(job);

  clearTimeout(set.timer);
  if (set.jobs.length >= set.total) {
    void flushImageSet(key);
  } else {
    // รูปที่เหลือไม่มาภายในเวลา (เช่น ลูกค้าส่งไม่สำเร็จ) → อ่านเท่าที่มี
    set.timer = setTimeout(() => void flushImageSet(key), IMAGE_SET_WAIT_MS);
  }
}

/** อ่านทีละรูปตามลำดับ → เขียนชีตทีเดียว → ตอบ LINE ครั้งเดียว — ไม่ throw */
async function flushImageSet(key: string): Promise<void> {
  const set = pendingSets.get(key);
  if (!set) return;
  pendingSets.delete(key);
  clearTimeout(set.timer);

  const jobs = [...set.jobs].sort((a, b) => (a.imageSet?.index ?? 0) - (b.imageSet?.index ?? 0));
  if (env.receiptAutoReply) void startLoading(jobs[0].lineUserId, 60);

  // ทีละรูป (ไม่ยิงพร้อมกัน) — ลดโอกาสโดน 429/503 จาก Gemini
  const results: { job: ReceiptJob; outcome: ReceiptOutcome }[] = [];
  for (const job of jobs) {
    const outcome = await extractReceipt(job.messageId, job.lineMessageId, { syncSheet: false });
    if (outcome) results.push({ job, outcome }); // null = เคยอ่าน/กำลังอ่านแล้ว → ไม่ตอบซ้ำ
  }

  await syncReceiptsToSheet(results.filter((r) => r.outcome.status === "done").map((r) => r.job.messageId));
  if (results.length === 0 || !env.receiptAutoReply) return;

  // ตอบด้วย replyToken ของรูปล่าสุด (ใหม่สุด → ยังไม่หมดอายุมากที่สุด)
  const latest = results.reduce((a, b) => (b.job.sentAt > a.job.sentAt ? b : a)).job;
  const texts =
    results.length === 1 ? [formatReceiptReply(results[0].outcome)] : formatReceiptSetReply(results.map((r) => r.outcome));
  try {
    await sendBotTexts(latest, texts, results.map((r) => r.job.messageId));
  } catch (err) {
    console.error("[receipt] send set reply failed", key, err);
  }
}

/** entry point จาก webhook (หลังตอบ 200) — ไม่ throw */
export async function handleReceiptImage(job: ReceiptJob): Promise<void> {
  // จุด ... กำลังพิมพ์ ในแชตลูกค้าระหว่างรอ AI (หายเองเมื่อบอทตอบ) — พังไม่เป็นไร
  if (env.receiptAutoReply) void startLoading(job.lineUserId, 60);

  // หลายรูปส่งพร้อมกัน → รอให้ครบชุด แล้วอ่าน/บันทึก/ตอบรวมครั้งเดียว
  if (job.imageSet && job.imageSet.total > 1) {
    queueImageSet({ ...job, imageSet: job.imageSet });
    return;
  }

  const outcome = await extractReceipt(job.messageId, job.lineMessageId);
  if (!outcome || !env.receiptAutoReply) return;

  try {
    await sendBotTexts(job, [formatReceiptReply(outcome)]);
  } catch (err) {
    console.error("[receipt] send reply failed", job.messageId, err);
  }
}
