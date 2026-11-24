import type { Request, Response } from "express";
import { BillDirection, BillDocType, BillStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getImage, isReadableImage, presignImage, uploadBillImage } from "../lib/storage.js";
import { clip, readReceiptImages, toDate, toDecimal, type ReceiptData } from "../lib/receipt.js";
import { writeBillsXlsx, type ExportBill } from "../lib/billExport.js";
import { r2Enabled } from "../config/env.js";
import { findOrCreatePartnerFromBill, findPartnerFromBill, rememberAlias } from "./partners.js";
import {
  BadRequest,
  handleError,
  isObject,
  optBool,
  optDate,
  optDecimal,
  optEnum,
  optTaxId,
  optText,
  optUuid,
  paramId,
  uuid,
} from "../lib/validate.js";

// บิลที่ผู้ใช้ตรวจ/แก้ได้ (ผลดิบจาก AI อยู่ใน receipt_extractions)

const DIRECTIONS = Object.values(BillDirection);
const DOC_TYPES = Object.values(BillDocType);
const STATUSES = Object.values(BillStatus);
const MAX_IMAGES = 3;
const MAX_ITEMS = 200;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

const include = {
  partner: { select: { id: true, displayName: true, taxId: true } },
  items: { orderBy: { lineNo: "asc" } },
  images: { orderBy: { position: "asc" } },
} satisfies Prisma.BillInclude;

type BillWithRelations = Prisma.BillGetPayload<{ include: typeof include }>;

/** แนบ URL รูป (หมดอายุ 5 นาที) ให้หน้าเว็บแสดงได้ */
async function withImageUrls(bill: BillWithRelations) {
  const images = await Promise.all(
    bill.images.map(async (img) => ({
      ...img,
      url: img.imageKey && r2Enabled() ? await presignImage(img.imageKey).catch(() => null) : null,
    })),
  );
  return { ...bill, images };
}

// ───────────────────────── validate body ─────────────────────────

type ItemInput = Omit<Prisma.BillItemCreateManyInput, "billId">;

function parseItems(v: unknown): ItemInput[] {
  if (!Array.isArray(v)) throw new BadRequest("items must be an array");
  if (v.length > MAX_ITEMS) throw new BadRequest(`items must have at most ${MAX_ITEMS} rows`);
  return v.map((raw, i) => {
    if (!isObject(raw)) throw new BadRequest(`items[${i}] must be an object`);
    const f = (name: string) => `items[${i}].${name}`;
    const quantity = optDecimal(raw.quantity, f("quantity"), 3) ?? null;
    const unitPrice = optDecimal(raw.unitPrice, f("unitPrice")) ?? null;
    // สร้าง/แก้ไขบิล: ไม่ได้ส่งจำนวนเงิน แต่มีจำนวน + ราคาต่อหน่วย → จำนวนเงิน = จำนวน × ราคา
    const amount =
      optDecimal(raw.amount, f("amount")) ?? (quantity && unitPrice ? quantity.mul(unitPrice).toDecimalPlaces(2) : null);
    return {
      lineNo: i + 1, // เรียงตามลำดับใน array
      name: optText(raw.name, f("name"), 255) ?? null,
      quantity,
      unit: optText(raw.unit, f("unit"), 30) ?? null,
      unitPrice,
      amount,
    };
  });
}

type BillFields = {
  direction?: BillDirection;
  docType?: BillDocType;
  status?: BillStatus;
  billNo?: string | null;
  billDate?: Date | null;
  partnerNameRaw?: string | null;
  partnerTaxIdRaw?: string | null;
  partnerId?: string | null;
  subtotal?: Prisma.Decimal | null;
  discount?: Prisma.Decimal | null;
  vat?: Prisma.Decimal | null;
  total?: Prisma.Decimal | null;
  paidAmount?: Prisma.Decimal;
  currency?: string;
  paymentMethod?: string | null;
  note?: string | null;
};

/** ช่องของบิล — ไม่ส่ง = ไม่แก้, null = ล้างค่า */
function parseFields(b: Record<string, unknown>): BillFields {
  const f: BillFields = {
    direction: optEnum(b.direction, "direction", DIRECTIONS),
    docType: optEnum(b.docType, "docType", DOC_TYPES),
    status: optEnum(b.status, "status", STATUSES),
    billNo: optText(b.billNo, "billNo", 100),
    billDate: optDate(b.billDate, "billDate"),
    partnerNameRaw: optText(b.partnerNameRaw, "partnerNameRaw", 255),
    partnerTaxIdRaw: optTaxId(b.partnerTaxIdRaw, "partnerTaxIdRaw"),
    partnerId: optUuid(b.partnerId, "partnerId"),
    subtotal: optDecimal(b.subtotal, "subtotal"),
    discount: optDecimal(b.discount, "discount"),
    vat: optDecimal(b.vat, "vat"),
    total: optDecimal(b.total, "total"),
    paymentMethod: optText(b.paymentMethod, "paymentMethod", 30),
    note: optText(b.note, "note", 2000),
  };
  if (b.paidAmount !== undefined) {
    const paid = optDecimal(b.paidAmount, "paidAmount");
    if (paid === null || paid === undefined || paid.isNegative()) throw new BadRequest("paidAmount must be >= 0");
    f.paidAmount = paid;
  }
  if (b.currency !== undefined) {
    const c = optText(b.currency, "currency", 3)?.toUpperCase();
    if (!c || !/^[A-Z]{3}$/.test(c)) throw new BadRequest("currency must be a 3-letter code e.g. THB");
    f.currency = c;
  }
  for (const k of Object.keys(f) as (keyof BillFields)[]) if (f[k] === undefined) delete f[k];
  return f;
}

/**
 * คู่ค้าที่เลือกใช้กับบิลนี้ได้ไหม — คืน contactId ของคู่ค้า (ไว้จำ alias ในขอบเขตของคู่ค้า)
 * ห้ามเฉพาะกรณีบิลกับคู่ค้าเป็นของผู้ใช้ LINE คนละคน (คู่ค้ากลาง/บิลจากหน้าเว็บ ใช้ร่วมกันได้)
 */
async function assertPartnerUsable(tx: Prisma.TransactionClient, partnerId: string, billContactId: string | null) {
  const p = await tx.partner.findUnique({ where: { id: partnerId }, select: { contactId: true } });
  if (!p) throw new BadRequest("partner not found");
  if (p.contactId && billContactId && p.contactId !== billContactId) {
    throw new BadRequest("partner belongs to another user");
  }
  return p.contactId;
}

// ───────────────────────── handlers ─────────────────────────

/**
 * GET /api/bills?contactId=&direction=&status=&docType=&partnerId=(uuid|none)&from=&to=&q=&page=1&pageSize=30
 * from/to = ช่วงวันที่บิล (YYYY-MM-DD), partnerId=none = บิลที่ยังไม่ระบุคู่ค้า
 */
/** ตัวกรองบิลจาก query (ใช้ร่วมกันระหว่างหน้ารายการกับ export) — ค่าผิดรูปแบบ = BadRequest */
export function billWhereFromQuery(qy: Request["query"]): Prisma.BillWhereInput {
  const where: Prisma.BillWhereInput = {};
  if (qy.contactId !== undefined) where.contactId = uuid(qy.contactId, "contactId");
  if (qy.direction !== undefined) where.direction = optEnum(qy.direction, "direction", DIRECTIONS);
  if (qy.status !== undefined) where.status = optEnum(qy.status, "status", STATUSES);
  if (qy.docType !== undefined) where.docType = optEnum(qy.docType, "docType", DOC_TYPES);
  if (qy.partnerId === "none") where.partnerId = null;
  else if (qy.partnerId !== undefined) where.partnerId = uuid(qy.partnerId, "partnerId");

  const from = optDate(qy.from, "from");
  const to = optDate(qy.to, "to");
  if (from && to && from > to) throw new BadRequest("from must be on or before to");
  if (from || to) where.billDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const q = optText(qy.q, "q", 100);
  if (q) {
    where.OR = [
      { billNo: { contains: q, mode: "insensitive" } },
      { partnerNameRaw: { contains: q, mode: "insensitive" } },
      { partner: { displayName: { contains: q, mode: "insensitive" } } },
      { note: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export async function listBills(req: Request, res: Response) {
  try {
    const qy = req.query;
    const where = billWhereFromQuery(qy);

    const page = qy.page === undefined ? 1 : Number(qy.page);
    const pageSize = qy.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(qy.pageSize);
    if (!Number.isInteger(page) || page < 1) throw new BadRequest("page must be >= 1");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new BadRequest(`pageSize must be 1-${MAX_PAGE_SIZE}`);
    }

    const [total, items] = await prisma().$transaction([
      prisma().bill.count({ where }),
      prisma().bill.findMany({
        where,
        include: {
          partner: include.partner,
          images: { orderBy: { position: "asc" }, select: { id: true, position: true, imageKey: true } },
          _count: { select: { items: true } },
        },
        orderBy: [{ billDate: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({ items, page, pageSize, total });
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/** GET /api/bills/:id — รวมรายการสินค้า + รูป (มี url ชั่วคราว) */
export async function getBill(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    const bill = await prisma().bill.findUnique({ where: { id }, include });
    if (!bill) return res.status(404).json({ error: "bill not found" });
    res.json(await withImageUrls(bill));
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/**
 * POST /api/bills — { direction, contactId?, partnerId?, ...ช่องอื่น, items?: [...], extractionIds?: [uuid] (รูปจาก LINE สูงสุด 3),
 *   newPartnerName?: string — ไม่มี partnerId: หาคู่ค้าชื่อนี้ ไม่เจอ = สร้างใหม่ (จำ partnerNameRaw เป็นชื่ออื่นด้วย),
 *   aiData?: object — ผลดิบจาก POST /api/bills/read (เก็บไว้ดูย้อนหลัง) }
 */
export async function createBill(req: Request, res: Response) {
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const b = req.body;
    const contactId = optUuid(b.contactId, "contactId") ?? null; // ว่าง = เพิ่มจากหน้าเว็บ
    const fields = parseFields(b);
    if (!fields.direction) throw new BadRequest(`direction is required (${DIRECTIONS.join(", ")})`);
    const items = b.items === undefined ? [] : parseItems(b.items);
    const extractionIds = b.extractionIds === undefined ? [] : parseExtractionIds(b.extractionIds);
    const newPartnerName = optText(b.newPartnerName, "newPartnerName", 255);
    if (newPartnerName && fields.partnerId) throw new BadRequest("send either partnerId or newPartnerName");
    let aiData: Prisma.InputJsonValue | undefined;
    if (b.aiData !== undefined && b.aiData !== null) {
      if (!isObject(b.aiData)) throw new BadRequest("aiData must be an object");
      if (JSON.stringify(b.aiData).length > 200_000) throw new BadRequest("aiData is too large");
      aiData = b.aiData as Prisma.InputJsonValue;
    }

    const bill = await prisma().$transaction(async (tx) => {
      // คู่ค้าใหม่จากชื่อที่ผู้ใช้ยืนยัน (ชื่อซ้ำกับคู่ค้าเดิม = ใช้คู่ค้าเดิม)
      if (newPartnerName) {
        const partner = await findOrCreatePartnerFromBill(tx, contactId, newPartnerName, fields.partnerTaxIdRaw);
        if (partner) fields.partnerId = partner.id;
      }
      const partnerScope = fields.partnerId ? await assertPartnerUsable(tx, fields.partnerId, contactId) : null;
      const images = await loadExtractionImages(tx, extractionIds, contactId);

      const created = await tx.bill.create({
        data: {
          ...fields,
          direction: fields.direction!,
          contactId,
          ...(aiData ? { aiData, aiReadAt: new Date() } : {}),
          confirmedAt: fields.status === "confirmed" ? new Date() : null,
          items: { createMany: { data: items } },
          images: { createMany: { data: images.map((img, i) => ({ ...img, position: i + 1 })) } },
        },
      });
      if (fields.partnerId && fields.partnerNameRaw) {
        await rememberAlias(tx, partnerScope, fields.partnerId, fields.partnerNameRaw);
      }
      return tx.bill.findUniqueOrThrow({ where: { id: created.id }, include });
    });
    res.status(201).json(await withImageUrls(bill));
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/**
 * PATCH /api/bills/:id — ช่องที่ส่งมาเท่านั้น; items ส่งมา = แทนที่รายการทั้งหมด
 * เลือก partnerId + rememberAlias (ค่าเริ่มต้น true) → จำชื่อตามบิล (partnerNameRaw) เป็นชื่ออื่นของคู่ค้านั้น
 */
export async function updateBill(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const b = req.body;
    if (b.contactId !== undefined) throw new BadRequest("contactId cannot be changed");
    const fields = parseFields(b);
    const items = b.items === undefined ? undefined : parseItems(b.items);
    const remember = optBool(b.rememberAlias, "rememberAlias") ?? true;
    if (Object.keys(fields).length === 0 && !items) throw new BadRequest("nothing to update");

    const bill = await prisma().$transaction(async (tx) => {
      const current = await tx.bill.findUniqueOrThrow({
        where: { id },
        select: { contactId: true, status: true, partnerNameRaw: true },
      });
      const partnerScope = fields.partnerId ? await assertPartnerUsable(tx, fields.partnerId, current.contactId) : null;

      const data: Prisma.BillUncheckedUpdateInput = { ...fields };
      if (fields.status === "confirmed" && current.status !== "confirmed") data.confirmedAt = new Date();
      if (fields.status && fields.status !== "confirmed") data.confirmedAt = null;
      await tx.bill.update({ where: { id }, data });

      if (items) {
        await tx.billItem.deleteMany({ where: { billId: id } });
        if (items.length) await tx.billItem.createMany({ data: items.map((it) => ({ ...it, billId: id })) });
        await tx.bill.update({ where: { id }, data: { updatedAt: new Date() } }); // ให้ชีตรู้ว่าต้องอัปเดต
      }

      const rawName = fields.partnerNameRaw ?? current.partnerNameRaw;
      if (remember && fields.partnerId && rawName) {
        await rememberAlias(tx, partnerScope, fields.partnerId, rawName);
      }
      return tx.bill.findUniqueOrThrow({ where: { id }, include });
    });
    res.json(await withImageUrls(bill));
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/** DELETE /api/bills/:id — ลบถาวร (รายการ+รูปที่ผูกถูกลบด้วย, ไฟล์ใน R2 ยังอยู่) ถ้าแค่ยกเลิกใช้ PATCH status=void */
export async function deleteBill(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    await prisma().bill.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    handleError(err, res, "bill");
  }
}

// ───────────────────────── รูปของบิล ─────────────────────────

function parseExtractionIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BadRequest("extractionIds must be an array");
  if (v.length > MAX_IMAGES) throw new BadRequest(`a bill can have at most ${MAX_IMAGES} images`);
  const ids = v.map((x, i) => uuid(x, `extractionIds[${i}]`));
  if (new Set(ids).size !== ids.length) throw new BadRequest("extractionIds must not repeat");
  return ids;
}

/** ผลอ่านรูปจาก LINE → ข้อมูลรูปของบิล (ต้องเป็นรูปของผู้ใช้คนเดียวกัน และยังไม่ถูกผูกกับบิลอื่น) */
async function loadExtractionImages(tx: Prisma.TransactionClient, ids: string[], contactId: string | null) {
  if (ids.length === 0) return [];
  const rows = await tx.receiptExtraction.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      imageKey: true,
      billImage: { select: { id: true } },
      message: { select: { conversation: { select: { contactId: true } } } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new BadRequest(`extraction ${id} not found`);
    if (contactId && r.message.conversation.contactId !== contactId) {
      throw new BadRequest(`extraction ${id} belongs to another user`);
    }
    if (r.billImage) throw new BadRequest(`extraction ${id} is already attached to a bill`);
    return { extractionId: id, imageKey: r.imageKey };
  });
}

/** POST /api/bills/:id/images — { extractionId } แนบรูปที่ลูกค้าส่งทาง LINE (สูงสุด 3 รูปต่อบิล) */
export async function addBillImage(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const extractionId = uuid(req.body.extractionId, "extractionId");

    const image = await prisma().$transaction(async (tx) => {
      const bill = await tx.bill.findUniqueOrThrow({
        where: { id },
        select: { contactId: true, images: { select: { position: true } } },
      });
      const used = new Set(bill.images.map((i) => i.position));
      const position = [1, 2, 3].find((p) => !used.has(p));
      if (!position) throw new BadRequest(`a bill can have at most ${MAX_IMAGES} images`);

      const [img] = await loadExtractionImages(tx, [extractionId], bill.contactId);
      const created = await tx.billImage.create({ data: { ...img, billId: id, position } });
      await tx.bill.update({ where: { id }, data: { updatedAt: new Date() } });
      return created;
    });
    res.status(201).json(image);
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/**
 * POST /api/bills/:id/images/upload — body = ไฟล์รูป 1 รูป (Content-Type: image/jpeg | image/png | image/webp)
 * ย่อแล้วเก็บใน R2 → เพิ่มเป็นรูปของบิล (สูงสุด 3 รูป) — อัปโหลดหลายรูปให้ส่งทีละรูปตามลำดับ
 */
export async function uploadBillImageFile(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequest("send one image file as the request body (Content-Type: image/jpeg, image/png or image/webp)");
    }
    if (!r2Enabled()) return res.status(503).json({ error: "image storage not configured" });
    if (!(await isReadableImage(body))) throw new BadRequest("file is not a readable image");

    // เช็คก่อนอัปโหลด (ไม่เปลืองที่ ถ้าบิลไม่มี/รูปเต็ม) แล้วเช็คซ้ำตอนบันทึก
    const freePosition = async (tx: Prisma.TransactionClient | ReturnType<typeof prisma>) => {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id }, select: { images: { select: { position: true } } } });
      const used = new Set(bill.images.map((i) => i.position));
      const position = [1, 2, 3].find((p) => !used.has(p));
      if (!position) throw new BadRequest(`a bill can have at most ${MAX_IMAGES} images`);
      return position;
    };
    await freePosition(prisma());

    const imageKey = await uploadBillImage(id, body);
    const image = await prisma().$transaction(async (tx) => {
      const position = await freePosition(tx);
      const created = await tx.billImage.create({ data: { billId: id, position, imageKey } });
      await tx.bill.update({ where: { id }, data: { updatedAt: new Date() } });
      return created;
    });
    res.status(201).json({ ...image, url: await presignImage(imageKey).catch(() => null) });
  } catch (err) {
    handleError(err, res, "bill");
  }
}

/** DELETE /api/bills/:id/images/:imageId — เอารูปออกจากบิล (ไฟล์ใน R2 ยังอยู่) */
export async function deleteBillImage(req: Request, res: Response) {
  const id = paramId(req, res);
  const imageId = id && paramId(req, res, "imageId");
  if (!id || !imageId) return;
  try {
    const { count } = await prisma().billImage.deleteMany({ where: { id: imageId, billId: id } });
    if (count === 0) return res.status(404).json({ error: "image not found" });
    res.status(204).end();
  } catch (err) {
    handleError(err, res, "bill image");
  }
}

// ───────────────────────── ให้ AI อ่านรูปบิล ─────────────────────────

/** document_type ของ AI → ประเภทเอกสารของบิล */
const AI_DOC_TYPE: Record<string, BillDocType> = {
  receipt: "receipt",
  tax_invoice: "tax_invoice",
  abbreviated_tax_invoice: "tax_invoice",
  invoice: "invoice",
};

const PAYMENT_METHODS = new Set(["cash", "transfer", "qr", "credit_card", "credit"]);

/**
 * ผล AI → ช่องของบิล + รายการสินค้า
 * บิลซื้อ: คู่ค้า = ผู้ขาย (ร้านที่ออกบิล) / บิลขาย: คู่ค้า = ผู้ซื้อ (ลูกค้า)
 */
function mapAiResult(data: ReceiptData, direction: BillDirection) {
  const isSale = direction === "sale";
  const partnerTax = (isSale ? data.buyer_tax_id : data.merchant_tax_id)?.replace(/\D/g, "") ?? "";
  const currency = clip(data.currency, 3)?.toUpperCase();
  const fields = {
    billNo: clip(data.receipt_no, 100),
    billDate: toDate(data.date),
    partnerNameRaw: clip(isSale ? data.buyer_name : data.merchant_name, 255),
    partnerTaxIdRaw: partnerTax.length === 13 ? partnerTax : null,
    subtotal: toDecimal(data.subtotal),
    discount: toDecimal(data.discount),
    vat: toDecimal(data.vat),
    total: toDecimal(data.total),
    paymentMethod: data.payment_method && PAYMENT_METHODS.has(data.payment_method) ? data.payment_method : null,
  };
  const items = data.items.slice(0, MAX_ITEMS).map((it, i) => {
    const quantity =
      typeof it.quantity === "number" && Number.isFinite(it.quantity) ? new Prisma.Decimal(it.quantity.toFixed(3)) : null;
    const unitPrice = toDecimal(it.unit_price);
    // AI อ่านจำนวนเงินไม่ได้ แต่มีจำนวน + ราคาต่อหน่วย → จำนวนเงิน = จำนวน × ราคา
    const amount = toDecimal(it.amount) ?? (quantity && unitPrice ? quantity.mul(unitPrice).toDecimalPlaces(2) : null);
    return { lineNo: i + 1, name: clip(it.name, 255), quantity, unit: null as string | null, unitPrice, amount };
  });
  return {
    fields,
    items,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    docType: data.document_type ? (AI_DOC_TYPE[data.document_type] ?? null) : null,
  };
}

const READ_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_READ_IMAGE_BYTES = 6 * 1024 * 1024; // ต่อรูป (หลัง base64 decode) — FE ย่อรูปก่อนส่ง

/**
 * POST /api/bills/read — { direction, contactId?, images: [{ mimeType, data(base64) }] (1–3 รูป = บิลใบเดียว) }
 * ให้ AI อ่านรูป **โดยไม่บันทึกอะไรลง DB** — ให้หน้าเว็บแสดงให้ผู้ใช้ตรวจ/แก้ก่อนกดบันทึก (POST /api/bills)
 * ตอบ: ช่องของบิล + รายการ + คู่ค้าเดิมที่ตรงกับชื่อในบิล (matched) + ผลดิบ (aiData ส่งกลับมาตอนบันทึกได้)
 */
export async function readBillImages(req: Request, res: Response) {
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const b = req.body;
    const direction = optEnum(b.direction, "direction", DIRECTIONS);
    if (!direction) throw new BadRequest(`direction is required (${DIRECTIONS.join(", ")})`);
    const contactId = optUuid(b.contactId, "contactId") ?? null;
    if (!Array.isArray(b.images) || b.images.length === 0 || b.images.length > MAX_IMAGES) {
      throw new BadRequest(`images must have 1-${MAX_IMAGES} items`);
    }
    const images = [];
    for (const [i, raw] of (b.images as unknown[]).entries()) {
      if (!isObject(raw) || typeof raw.data !== "string" || typeof raw.mimeType !== "string") {
        throw new BadRequest(`images[${i}] must be { mimeType, data }`);
      }
      if (!READ_IMAGE_TYPES.includes(raw.mimeType)) throw new BadRequest(`images[${i}]: รองรับเฉพาะ JPG, PNG, WEBP`);
      const data = Buffer.from(raw.data.replace(/^data:[^,]*,/, ""), "base64");
      if (data.length === 0 || data.length > MAX_READ_IMAGE_BYTES) throw new BadRequest(`images[${i}]: ขนาดไฟล์ไม่ถูกต้อง`);
      if (!(await isReadableImage(data))) throw new BadRequest(`images[${i}] is not a readable image`);
      images.push({ data, mimeType: raw.mimeType });
    }

    const { data, model } = await readReceiptImages(images);
    const mapped = mapAiResult(data, direction);
    const matched = data.is_receipt
      ? await findPartnerFromBill(prisma(), contactId, mapped.fields.partnerNameRaw, mapped.fields.partnerTaxIdRaw)
      : null;

    res.json({
      ai: { model, isReceipt: data.is_receipt, notes: data.notes ?? null },
      fields: { ...mapped.fields, currency: mapped.currency, docType: mapped.docType },
      items: mapped.items,
      partner: {
        name: mapped.fields.partnerNameRaw,
        taxId: mapped.fields.partnerTaxIdRaw,
        matched: matched && { id: matched.id, displayName: matched.displayName, taxId: matched.taxId, reason: matched.reason },
      },
      aiData: { ...data, _model: model },
    });
  } catch (err) {
    if (err instanceof Error && !(err instanceof BadRequest) && !(err instanceof Prisma.PrismaClientKnownRequestError)) {
      console.error("[bills] read failed", err.message);
      return res.status(502).json({ error: `AI อ่านบิลไม่สำเร็จ: ${err.message.slice(0, 200)}` });
    }
    handleError(err, res, "bill");
  }
}

/**
 * POST /api/bills/:id/extract — { overwrite?: boolean }
 * ส่งรูปทั้งหมดของบิล (สูงสุด 3 รูป = บิลใบเดียว) ให้ AI อ่านในครั้งเดียว แล้วเติมข้อมูลลงบิล:
 * - ค่าเริ่มต้นเติมเฉพาะช่องที่ยังว่าง (overwrite: true = แทนที่ด้วยค่าที่ AI อ่านได้)
 * - รายการสินค้า: ใส่เมื่อบิลยังไม่มีรายการ (overwrite: true = แทนที่ทั้งหมด)
 * - คู่ค้า: ถ้ายังไม่ได้เลือก → ใช้ชื่อในบิล หาคู่ค้าเดิม ไม่เจอ = สร้างใหม่
 */
export async function extractBill(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    const overwrite = optBool(isObject(req.body) ? req.body.overwrite : undefined, "overwrite") ?? false;
    if (!r2Enabled()) return res.status(503).json({ error: "image storage not configured" });

    const bill = await prisma().bill.findUniqueOrThrow({
      where: { id },
      include: { images: { orderBy: { position: "asc" } }, _count: { select: { items: true } } },
    });
    const keys = bill.images.map((i) => i.imageKey).filter((k): k is string => !!k);
    if (keys.length === 0) throw new BadRequest("บิลนี้ยังไม่มีรูปให้อ่าน");

    const images = await Promise.all(keys.map((k) => getImage(k)));
    const { data, model } = await readReceiptImages(images);
    const aiData = { ...data, _model: model } as unknown as Prisma.InputJsonValue;

    if (!data.is_receipt) {
      await prisma().bill.update({ where: { id }, data: { aiData, aiReadAt: new Date() } });
      const fresh = await prisma().bill.findUniqueOrThrow({ where: { id }, include });
      return res.json({
        bill: await withImageUrls(fresh),
        ai: { model, isReceipt: false, filled: [], partnerCreated: false, notes: data.notes ?? null },
      });
    }

    const mapped = mapAiResult(data, bill.direction);
    const filled: string[] = [];
    const update: Prisma.BillUncheckedUpdateInput = { aiData, aiReadAt: new Date() };
    for (const [key, value] of Object.entries(mapped.fields) as [keyof typeof mapped.fields, unknown][]) {
      if (value === null || value === undefined) continue;
      if (overwrite || bill[key] === null) {
        (update as Record<string, unknown>)[key] = value;
        filled.push(key);
      }
    }
    if (mapped.currency && (overwrite || bill.currency === "THB") && mapped.currency !== bill.currency) {
      update.currency = mapped.currency;
      filled.push("currency");
    }
    if (mapped.docType && (overwrite || bill.docType === "other") && mapped.docType !== bill.docType) {
      update.docType = mapped.docType;
      filled.push("docType");
    }
    const replaceItems = mapped.items.length > 0 && (overwrite || bill._count.items === 0);

    let partnerCreated = false;
    const saved = await prisma().$transaction(async (tx) => {
      if (replaceItems) {
        await tx.billItem.deleteMany({ where: { billId: id } });
        await tx.billItem.createMany({ data: mapped.items.map((it) => ({ ...it, billId: id })) });
        filled.push("items");
      }
      // ยังไม่ได้เลือกคู่ค้า → ใช้ชื่อตามบิล (ที่บันทึกไว้หรือที่ AI เพิ่งอ่าน)
      if (!bill.partnerId) {
        const rawName = (update.partnerNameRaw as string | undefined) ?? bill.partnerNameRaw;
        const rawTax = (update.partnerTaxIdRaw as string | undefined) ?? bill.partnerTaxIdRaw;
        const partner = await findOrCreatePartnerFromBill(tx, bill.contactId, rawName, rawTax);
        if (partner) {
          update.partnerId = partner.id;
          partnerCreated = partner.created;
          filled.push("partnerId");
        }
      }
      await tx.bill.update({ where: { id }, data: update });
      return tx.bill.findUniqueOrThrow({ where: { id }, include });
    });

    res.json({
      bill: await withImageUrls(saved),
      ai: { model, isReceipt: true, filled, partnerCreated, notes: data.notes ?? null },
    });
  } catch (err) {
    if (err instanceof Error && !(err instanceof BadRequest) && !(err instanceof Prisma.PrismaClientKnownRequestError)) {
      console.error("[bills] extract failed", id, err.message);
      return res.status(502).json({ error: `AI อ่านบิลไม่สำเร็จ: ${err.message.slice(0, 200)}` });
    }
    handleError(err, res, "bill");
  }
}

// ───────────────────────── export .xlsx ─────────────────────────

const EXPORT_BATCH = 500;
const EXPORT_MAX_BILLS = 50_000;

const num = (v: Prisma.Decimal | null) => (v === null ? null : v.toNumber());

/**
 * GET /api/bills/export?from=YYYY-MM-DD&to=YYYY-MM-DD&(ตัวกรองเดียวกับ GET /api/bills)
 * ไฟล์ .xlsx: แผ่น "บิล" (1 บิล = 1 แถว + แถวรวมท้าย), "รายการสินค้า", "ข้อมูลการส่งออก"
 * from/to บังคับ, ไม่ระบุ status = ไม่รวมบิลที่ยกเลิก — เขียนแบบ stream อ่าน DB ทีละ 500 บิล
 */
export async function exportBills(req: Request, res: Response) {
  let where: Prisma.BillWhereInput;
  let from: Date;
  let to: Date;
  try {
    const f = optDate(req.query.from, "from");
    const t = optDate(req.query.to, "to");
    if (!f || !t) throw new BadRequest("from and to are required (YYYY-MM-DD)");
    from = f;
    to = t;
    where = billWhereFromQuery(req.query);
    if (req.query.status === undefined) where.status = { not: "void" };
    const count = await prisma().bill.count({ where });
    if (count > EXPORT_MAX_BILLS) {
      throw new BadRequest(`ช่วงเวลานี้มี ${count.toLocaleString("th-TH")} บิล เกิน ${EXPORT_MAX_BILLS.toLocaleString("th-TH")} — กรุณาเลือกช่วงให้สั้นลง`);
    }
  } catch (err) {
    return handleError(err, res, "bill");
  }

  const direction = typeof where.direction === "string" ? where.direction : undefined;
  const kind = direction === "purchase" ? "purchase-bills" : direction === "sale" ? "sale-bills" : "bills";
  const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `${kind}_${day(from)}-${day(to)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "no-store");

  // อ่าน DB ทีละชุด (cursor) — ไม่โหลดทุกบิลพร้อมกัน
  async function* batches(): AsyncGenerator<ExportBill[]> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma().bill.findMany({
        where,
        orderBy: [{ billDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          partner: { select: { displayName: true, taxId: true } },
          items: { orderBy: { lineNo: "asc" } },
        },
      });
      if (rows.length === 0) return;
      yield rows.map((b) => ({
        billDate: b.billDate,
        direction: b.direction,
        docType: b.docType,
        billNo: b.billNo,
        partnerName: b.partner?.displayName ?? null,
        partnerNameRaw: b.partnerNameRaw,
        partnerTaxId: b.partner?.taxId ?? b.partnerTaxIdRaw,
        subtotal: num(b.subtotal),
        discount: num(b.discount),
        vat: num(b.vat),
        total: num(b.total),
        paidAmount: b.paidAmount.toNumber(),
        currency: b.currency,
        paymentMethod: b.paymentMethod,
        status: b.status,
        note: b.note,
        createdAt: b.createdAt,
        items: b.items.map((it) => ({
          lineNo: it.lineNo,
          name: it.name,
          quantity: num(it.quantity),
          unit: it.unit,
          unitPrice: num(it.unitPrice),
          amount: num(it.amount),
        })),
      }));
      if (rows.length < EXPORT_BATCH) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  try {
    const fmt = (d: Date) => d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const label = direction === "purchase" ? "บิลซื้อ" : direction === "sale" ? "บิลขาย" : "บิล";
    const result = await writeBillsXlsx(res, batches(), {
      title: `รายงาน${label} ${fmt(from)} – ${fmt(to)}`,
      from,
      to,
      direction,
    });
    console.log("[bills] exported", filename, result);
  } catch (err) {
    console.error("[bills] export failed", err instanceof Error ? err.message : err);
    // ส่ง header ไปแล้ว → ตัดการเชื่อมต่อให้ฝั่งรู้ว่าไฟล์ไม่สมบูรณ์
    if (!res.headersSent) handleError(err, res, "bill");
    else res.destroy(err instanceof Error ? err : undefined);
  }
}
