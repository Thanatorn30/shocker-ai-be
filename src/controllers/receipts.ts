import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { presignImage, verifyImageSig } from "../lib/storage.js";
import { r2Enabled } from "../config/env.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/receipts/:messageId/image?sig=... */
export async function receiptImage(req: Request, res: Response) {
  const messageId = String(req.params.messageId);
  if (!UUID.test(messageId) || !verifyImageSig(messageId, req.query.sig)) {
    return res.status(404).json({ error: "not found" }); // ไม่บอกว่าลายเซ็นผิดหรือไม่มีรูป
  }
  if (!r2Enabled()) return res.status(503).json({ error: "image storage not configured" });

  try {
    const row = await prisma().receiptExtraction.findUnique({ where: { messageId }, select: { imageKey: true } });
    if (!row?.imageKey) return res.status(404).json({ error: "not found" });

    res.set("Cache-Control", "private, max-age=60");
    return res.redirect(302, await presignImage(row.imageKey));
  } catch (err) {
    console.error("[receipts] image failed", messageId, err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "internal error" });
  }
}
