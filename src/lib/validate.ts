import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";

// ตัวช่วย validate ค่าจาก body/query — โยน BadRequest แล้ว controller ตอบ 400

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadRequest extends Error {}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** อ่าน :param ที่เป็น uuid — ผิดรูปแบบ = ตอบ 400 แล้วคืน undefined */
export function paramId(req: Request, res: Response, name = "id"): string | undefined {
  const id = String(req.params[name]);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: `invalid ${name}` });
    return undefined;
  }
  return id;
}

export function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new BadRequest(`${field} must be a uuid`);
  return v;
}

/** undefined = ไม่ได้ส่งมา (ไม่แก้), null = ล้างค่า */
export function optUuid(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null) return v;
  return uuid(v, field);
}

/** ข้อความ — "" หรือช่องว่างล้วน = null */
export function optText(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string") throw new BadRequest(`${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return t || null;
}

export function text(v: unknown, field: string, max: number): string {
  const t = optText(v, field, max);
  if (!t) throw new BadRequest(`${field} is required`);
  return t;
}

/** เงิน/จำนวน — รับ number หรือ string ตัวเลข ("1,250.50" ได้) */
export function optDecimal(v: unknown, field: string, scale = 2): Prisma.Decimal | null | undefined {
  if (v === undefined || v === null) return v;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || (typeof v === "string" && v.trim() === "")) {
    throw new BadRequest(`${field} must be a number`);
  }
  if (Math.abs(n) >= 1e10) throw new BadRequest(`${field} is too large`);
  return new Prisma.Decimal(n.toFixed(scale));
}

/** "YYYY-MM-DD" (ค.ศ.) → Date */
export function optDate(v: unknown, field: string): Date | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequest(`${field} must be YYYY-MM-DD`);
  }
  const d = new Date(`${v}T00:00:00Z`);
  const y = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || y < 2000 || y > 2100) {
    throw new BadRequest(`${field} is not a valid date (ใช้ปี ค.ศ.)`);
  }
  return d;
}

export function optEnum<T extends string>(v: unknown, field: string, values: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new BadRequest(`${field} must be one of: ${values.join(", ")}`);
  }
  return v as T;
}

export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new BadRequest(`${field} must be true or false`);
  return v;
}

/** เลขผู้เสียภาษี — เก็บเฉพาะตัวเลข 13 หลัก */
export function optTaxId(v: unknown, field: string): string | null | undefined {
  const t = optText(v, field, 32);
  if (t === undefined || t === null) return t;
  const digits = t.replace(/\D/g, "");
  if (digits.length !== 13) throw new BadRequest(`${field} must be 13 digits`);
  return digits;
}

/** ตอบ error มาตรฐาน: BadRequest → 400, Prisma not found → 404, ซ้ำ → 409 */
export function handleError(err: unknown, res: Response, what: string): void {
  if (err instanceof BadRequest) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      res.status(404).json({ error: `${what} not found` });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ error: `${what} already exists`, target: err.meta?.target ?? null });
      return;
    }
    if (err.code === "P2003") {
      res.status(400).json({ error: "related record not found" });
      return;
    }
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
}
