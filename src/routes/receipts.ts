import { Router } from "express";
import { receiptImage } from "../controllers/receipts.js";

// ไม่ใช้ requireAuth — ป้องกันด้วยลายเซ็นในลิงก์ (?sig=) เพราะเปิดจาก Google Sheet
export const receiptsRouter = Router();

/** GET /api/receipts/:messageId/image?sig=... → redirect ไปรูปใน R2 (URL หมดอายุ 5 นาที) */
receiptsRouter.get("/:messageId/image", receiptImage);
