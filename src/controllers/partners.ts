import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { nameSimilarity, normalizePartnerName } from "../lib/partnerName.js";
import {
  BadRequest,
  handleError,
  isObject,
  optTaxId,
  optText,
  optUuid,
  paramId,
  text,
  uuid,
} from "../lib/validate.js";

// คู่ค้า (ร้าน/ผู้ขาย/ลูกค้า) — ใช้ร่วมกันทั้งบิลซื้อและบิลขาย
// contactId ว่าง = คู่ค้ากลาง (เพิ่มจากหน้าเว็บ ใช้ได้ทุกบิล), มีค่า = คู่ค้าของผู้ใช้ LINE คนนั้น

const include = {
  aliases: { select: { id: true, alias: true, rawName: true, createdAt: true }, orderBy: { createdAt: "asc" } },
  _count: { select: { bills: true } },
} satisfies Prisma.PartnerInclude;

type Tx = Prisma.TransactionClient;

/** คู่ค้าที่บิลของ contactId นี้ใช้ได้: ของผู้ใช้คนนั้น + คู่ค้ากลาง (contactId ว่าง = ทุกคู่ค้า) */
export function partnerScope(contactId: string | null): Prisma.PartnerWhereInput {
  return contactId ? { OR: [{ contactId }, { contactId: null }] } : {};
}

/**
 * จำว่าชื่อนี้ = คู่ค้านี้ — ชื่อเดิมเคยชี้ไปคู่ค้าอื่น (ขอบเขตเดียวกัน) → ย้ายมาคู่ค้านี้ (ผู้ใช้เลือกล่าสุดถูกเสมอ)
 * ใช้ findFirst แทน upsert เพราะ contactId ว่างได้ (unique ของ Postgres ไม่กันค่าว่างซ้ำ)
 */
export async function rememberAlias(tx: Tx, contactId: string | null, partnerId: string, rawName: string) {
  const alias = normalizePartnerName(rawName);
  if (!alias) return null;
  const name = rawName.trim().slice(0, 255);
  const existing = await tx.partnerAlias.findFirst({ where: { contactId, alias }, select: { id: true } });
  if (existing) {
    return tx.partnerAlias.update({ where: { id: existing.id }, data: { partnerId, rawName: name } });
  }
  return tx.partnerAlias.create({ data: { contactId, partnerId, alias, rawName: name } });
}

/** เลขภาษีซ้ำในขอบเขตเดียวกัน (unique index ไม่ครอบคลุมคู่ค้ากลาง) */
async function assertTaxIdFree(tx: Tx, contactId: string | null, taxId: string | null | undefined, exceptId?: string) {
  if (!taxId) return;
  const dup = await tx.partner.findFirst({
    where: { contactId, taxId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { displayName: true },
  });
  if (dup) throw new BadRequest(`เลขผู้เสียภาษีนี้เป็นของคู่ค้า "${dup.displayName}" อยู่แล้ว`);
}

type PartnerDb = Tx | ReturnType<typeof prisma>;

/**
 * หาคู่ค้าเดิมจากชื่อ/เลขภาษีที่อ่านจากบิล (ไม่เขียน DB): เลขภาษีตรง → ชื่อที่เคยยืนยัน (alias) → ชื่อคู่ค้าตรงกัน
 */
export async function findPartnerFromBill(
  db: PartnerDb,
  contactId: string | null,
  rawName: string | null | undefined,
  rawTaxId: string | null | undefined,
): Promise<{ id: string; displayName: string; taxId: string | null; reason: "tax_id" | "alias" | "name" } | null> {
  const name = rawName?.trim();
  const taxId = rawTaxId?.replace(/\D/g, "");
  const scope = partnerScope(contactId);
  const select = { id: true, displayName: true, taxId: true } as const;

  if (taxId?.length === 13) {
    const byTax = await db.partner.findFirst({ where: { AND: [scope, { taxId }] }, select });
    if (byTax) return { ...byTax, reason: "tax_id" };
  }
  const alias = name ? normalizePartnerName(name) : "";
  if (!alias) return null;

  const byAlias = await db.partnerAlias.findFirst({
    where: { alias, partner: scope },
    select: { partner: { select } },
    orderBy: { createdAt: "desc" },
  });
  if (byAlias) return { ...byAlias.partner, reason: "alias" };

  // ชื่อคู่ค้าที่มีอยู่ normalize แล้วตรงกัน (เช่น ตั้งชื่อเองโดยยังไม่มี alias)
  const candidates = await db.partner.findMany({ where: scope, select });
  const same = candidates.find((p) => normalizePartnerName(p.displayName) === alias);
  return same ? { ...same, reason: "name" } : null;
}

/**
 * หาคู่ค้าเดิม (findPartnerFromBill) ไม่เจอ → สร้างคู่ค้าใหม่ด้วยชื่อตามบิล (ขอบเขตเดียวกับบิล)
 * จำชื่อตามบิลเป็น alias ของคู่ค้าที่ได้ — คืน null ถ้าไม่มีชื่อให้ใช้
 */
export async function findOrCreatePartnerFromBill(
  tx: Tx,
  contactId: string | null,
  rawName: string | null | undefined,
  rawTaxId: string | null | undefined,
): Promise<{ id: string; created: boolean } | null> {
  const name = rawName?.trim();
  const taxId = rawTaxId?.replace(/\D/g, "");
  const found = await findPartnerFromBill(tx, contactId, name, taxId);
  if (found) {
    if (name && found.reason !== "alias") await rememberAlias(tx, contactId, found.id, name);
    return { id: found.id, created: false };
  }
  if (!name) return null;

  const created = await tx.partner.create({
    data: { contactId, displayName: name.slice(0, 255), taxId: taxId?.length === 13 ? taxId : null },
  });
  await rememberAlias(tx, contactId, created.id, name);
  return { id: created.id, created: true };
}

/** GET /api/partners?contactId=&q= — ไม่ส่ง contactId = คู่ค้าทั้งหมด */
export async function listPartners(req: Request, res: Response) {
  try {
    const contactId = optUuid(req.query.contactId, "contactId") ?? null;
    const q = optText(req.query.q, "q", 100);
    const normalized = q ? normalizePartnerName(q) : "";

    const partners = await prisma().partner.findMany({
      where: {
        AND: [
          partnerScope(contactId),
          q
            ? {
                OR: [
                  { displayName: { contains: q, mode: "insensitive" } },
                  { taxId: { contains: q.replace(/\D/g, "") || q } },
                  ...(normalized ? [{ aliases: { some: { alias: { contains: normalized } } } }] : []),
                ],
              }
            : {},
        ],
      },
      include,
      orderBy: { displayName: "asc" },
      take: 500,
    });
    res.json({ items: partners });
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/**
 * GET /api/partners/suggest?contactId=&name=&taxId=
 * ตัวเลือกคู่ค้าสำหรับชื่อที่อ่านจากบิล — matched = เลขภาษีตรง/ชื่อที่เคยยืนยัน, candidates = เรียงตามความคล้าย
 */
export async function suggestPartners(req: Request, res: Response) {
  try {
    const contactId = optUuid(req.query.contactId, "contactId") ?? null;
    const name = optText(req.query.name, "name", 255) ?? "";
    const taxId = optTaxId(req.query.taxId, "taxId");
    const normalized = normalizePartnerName(name);

    const partners = await prisma().partner.findMany({
      where: partnerScope(contactId),
      select: { id: true, displayName: true, taxId: true, aliases: { select: { alias: true } } },
    });

    let matched: { partnerId: string; reason: "tax_id" | "alias" } | null = null;
    const scored = partners.map((p) => {
      const names = [normalizePartnerName(p.displayName), ...p.aliases.map((a) => a.alias)];
      let score = normalized ? Math.max(...names.map((n) => nameSimilarity(normalized, n))) : 0;
      if (taxId && p.taxId === taxId) {
        score = 1;
        matched ??= { partnerId: p.id, reason: "tax_id" };
      } else if (normalized && p.aliases.some((a) => a.alias === normalized)) {
        score = 1;
        matched ??= { partnerId: p.id, reason: "alias" };
      }
      return { id: p.id, displayName: p.displayName, taxId: p.taxId, score: Math.round(score * 100) / 100 };
    });

    const candidates = scored
      .filter((c) => c.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    res.json({ name, normalized, matched, candidates });
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/** GET /api/partners/:id */
export async function getPartner(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    const partner = await prisma().partner.findUnique({ where: { id }, include });
    if (!partner) return res.status(404).json({ error: "partner not found" });
    res.json(partner);
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/**
 * POST /api/partners — { contactId?, displayName, taxId?, phone?, note?, aliasFrom? }
 * ไม่ส่ง contactId = คู่ค้ากลาง — จำชื่อที่ตั้ง (และ aliasFrom เช่น ชื่อตามบิล) เป็น alias ให้ด้วย
 */
export async function createPartner(req: Request, res: Response) {
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const b = req.body;
    const contactId = optUuid(b.contactId, "contactId") ?? null;
    const displayName = text(b.displayName, "displayName", 255);
    const taxId = optTaxId(b.taxId, "taxId") ?? null;
    const aliasFrom = optText(b.aliasFrom, "aliasFrom", 255);

    const partner = await prisma().$transaction(async (tx) => {
      await assertTaxIdFree(tx, contactId, taxId);
      const created = await tx.partner.create({
        data: {
          contactId,
          displayName,
          taxId,
          phone: optText(b.phone, "phone", 20) ?? null,
          note: optText(b.note, "note", 2000) ?? null,
        },
      });
      await rememberAlias(tx, contactId, created.id, displayName);
      if (aliasFrom) await rememberAlias(tx, contactId, created.id, aliasFrom);
      return tx.partner.findUniqueOrThrow({ where: { id: created.id }, include });
    });
    res.status(201).json(partner);
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/** PATCH /api/partners/:id — { displayName?, taxId?, phone?, note? } */
export async function updatePartner(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const b = req.body;
    if (b.contactId !== undefined) throw new BadRequest("contactId cannot be changed");
    const data: Prisma.PartnerUpdateInput = {};
    if (b.displayName !== undefined) data.displayName = text(b.displayName, "displayName", 255);
    if (b.taxId !== undefined) data.taxId = optTaxId(b.taxId, "taxId");
    if (b.phone !== undefined) data.phone = optText(b.phone, "phone", 20);
    if (b.note !== undefined) data.note = optText(b.note, "note", 2000);
    if (Object.keys(data).length === 0) throw new BadRequest("nothing to update");

    const partner = await prisma().$transaction(async (tx) => {
      const current = await tx.partner.findUniqueOrThrow({ where: { id }, select: { contactId: true } });
      if (typeof data.taxId === "string") await assertTaxIdFree(tx, current.contactId, data.taxId, id);
      await tx.partner.update({ where: { id }, data });
      if (typeof data.displayName === "string") await rememberAlias(tx, current.contactId, id, data.displayName);
      return tx.partner.findUniqueOrThrow({ where: { id }, include });
    });
    res.json(partner);
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/** DELETE /api/partners/:id — บิลที่ผูกอยู่จะกลับเป็น "ยังไม่ระบุคู่ค้า" (partner_id = null) */
export async function deletePartner(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    await prisma().partner.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/** POST /api/partners/:id/aliases — { name } เพิ่มชื่ออื่นของคู่ค้า */
export async function addPartnerAlias(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const name = text(req.body.name, "name", 255);
    if (!normalizePartnerName(name)) throw new BadRequest("name has no usable characters");

    const alias = await prisma().$transaction(async (tx) => {
      const partner = await tx.partner.findUniqueOrThrow({ where: { id }, select: { contactId: true } });
      return rememberAlias(tx, partner.contactId, id, name);
    });
    res.status(201).json(alias);
  } catch (err) {
    handleError(err, res, "partner");
  }
}

/** DELETE /api/partners/:id/aliases/:aliasId */
export async function deletePartnerAlias(req: Request, res: Response) {
  const id = paramId(req, res);
  const aliasId = id && paramId(req, res, "aliasId");
  if (!id || !aliasId) return;
  try {
    const { count } = await prisma().partnerAlias.deleteMany({ where: { id: aliasId, partnerId: id } });
    if (count === 0) return res.status(404).json({ error: "alias not found" });
    res.status(204).end();
  } catch (err) {
    handleError(err, res, "alias");
  }
}

/**
 * POST /api/partners/:id/merge — { fromPartnerId }
 * รวมคู่ค้า fromPartnerId เข้ามาที่ :id (ย้ายบิล + ชื่ออื่นทั้งหมด แล้วลบตัวเดิม)
 */
export async function mergePartner(req: Request, res: Response) {
  const id = paramId(req, res);
  if (!id) return;
  try {
    if (!isObject(req.body)) throw new BadRequest("body must be a JSON object");
    const fromId = uuid(req.body.fromPartnerId, "fromPartnerId");
    if (fromId === id) throw new BadRequest("cannot merge a partner into itself");

    const partner = await prisma().$transaction(async (tx) => {
      const [into, from] = await Promise.all([
        tx.partner.findUniqueOrThrow({ where: { id } }),
        tx.partner.findUniqueOrThrow({ where: { id: fromId } }),
      ]);
      // คู่ค้าของผู้ใช้ LINE คนละคนรวมกันไม่ได้ (คู่ค้ากลางรวมกับใครก็ได้)
      if (into.contactId && from.contactId && into.contactId !== from.contactId) {
        throw new BadRequest("partners belong to different users");
      }

      await tx.bill.updateMany({ where: { partnerId: fromId }, data: { partnerId: id } });
      // ชื่ออื่นที่ซ้ำกับของคู่ค้าปลายทางอยู่แล้ว → ลบ, ที่เหลือย้ายมา (ขอบเขตของปลายทาง)
      const intoAliases = await tx.partnerAlias.findMany({ where: { partnerId: id }, select: { alias: true } });
      const have = new Set(intoAliases.map((a) => a.alias));
      const fromAliases = await tx.partnerAlias.findMany({ where: { partnerId: fromId } });
      for (const a of fromAliases) {
        if (have.has(a.alias)) await tx.partnerAlias.delete({ where: { id: a.id } });
        else await tx.partnerAlias.update({ where: { id: a.id }, data: { partnerId: id, contactId: into.contactId } });
      }
      await rememberAlias(tx, into.contactId, id, from.displayName);
      await tx.partner.delete({ where: { id: fromId } });
      if (!into.taxId && from.taxId) await tx.partner.update({ where: { id }, data: { taxId: from.taxId } });
      return tx.partner.findUniqueOrThrow({ where: { id }, include });
    });
    res.json(partner);
  } catch (err) {
    handleError(err, res, "partner");
  }
}
