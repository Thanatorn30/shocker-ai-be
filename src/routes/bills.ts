import express, { Router } from "express";
import {
  listBills,
  getBill,
  createBill,
  updateBill,
  deleteBill,
  addBillImage,
  uploadBillImageFile,
  extractBill,
  readBillImages,
  exportBills,
  deleteBillImage,
} from "../controllers/bills.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// บิล (ตรวจ/แก้ได้) — ต้อง login (owner / agent)
export const billsRouter = Router();

billsRouter.use(requireAuth);

/** GET /api/bills?contactId=&direction=&status=&docType=&partnerId=(uuid|none)&from=&to=&q=&page=&pageSize= */
billsRouter.get("/", listBills);

/** POST /api/bills — { contactId, direction, docType?, status?, billNo?, billDate?, partner..., ยอดเงิน..., items?, extractionIds? } */
billsRouter.post("/", createBill);

/**
 * POST /api/bills/read — { direction, contactId?, images: [{ mimeType, data(base64) }] } (1–3 รูป = บิลใบเดียว)
 * ให้ AI อ่านรูปโดยยังไม่บันทึก DB → หน้าเว็บให้ตรวจ/แก้ แล้วค่อย POST /api/bills
 * (body ใหญ่ — ตั้ง express.json limit ของ path นี้ไว้ใน src/index.ts)
 */
billsRouter.post("/read", readBillImages);

/**
 * GET /api/bills/export?from=YYYY-MM-DD&to=YYYY-MM-DD&(ตัวกรองเดียวกับรายการ) → ไฟล์ .xlsx
 * (ต้องอยู่ก่อน /:id) ไม่ระบุ status = ไม่รวมบิลที่ยกเลิก
 */
billsRouter.get("/export", exportBills);

/** GET /api/bills/:id — รวม items + images (url ชั่วคราว 5 นาที) */
billsRouter.get("/:id", getBill);

/** PATCH /api/bills/:id — ช่องที่ส่งมาเท่านั้น, items = แทนที่ทั้งหมด, rememberAlias (default true) */
billsRouter.patch("/:id", updateBill);

/** DELETE /api/bills/:id — ลบถาวร (owner เท่านั้น) ถ้าแค่ยกเลิกใช้ PATCH status=void */
billsRouter.delete("/:id", requireRole("owner"), deleteBill);

/** POST /api/bills/:id/images — { extractionId } แนบรูปจาก LINE (สูงสุด 3) */
billsRouter.post("/:id/images", addBillImage);

/**
 * POST /api/bills/:id/images/upload — body = ไฟล์รูป 1 รูป (image/jpeg | image/png | image/webp, ไม่เกิน 15MB)
 * ย่อแล้วเก็บใน R2 (สูงสุด 3 รูปต่อบิล) — หลายรูปให้ส่งทีละรูป
 */
billsRouter.post(
  "/:id/images/upload",
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }),
  uploadBillImageFile,
  extractBill,
  readBillImages,
  exportBills,
);

/**
 * POST /api/bills/:id/extract — { overwrite?: boolean } ให้ AI อ่านรูปทั้งหมดของบิลในครั้งเดียว
 * เติมช่องที่ว่าง + รายการสินค้า + คู่ค้า (ไม่ได้เลือก → หา/สร้างจากชื่อในบิล)
 */
billsRouter.post("/:id/extract", extractBill);

/** DELETE /api/bills/:id/images/:imageId */
billsRouter.delete("/:id/images/:imageId", deleteBillImage);
