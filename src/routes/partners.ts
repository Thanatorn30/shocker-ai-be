import { Router } from "express";
import {
  listPartners,
  suggestPartners,
  getPartner,
  createPartner,
  updatePartner,
  deletePartner,
  addPartnerAlias,
  deletePartnerAlias,
  mergePartner,
} from "../controllers/partners.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// คู่ค้าของผู้ใช้ LINE — ต้อง login (owner / agent)
export const partnersRouter = Router();

partnersRouter.use(requireAuth);

/** GET /api/partners?contactId=&q= */
partnersRouter.get("/", listPartners);

/** GET /api/partners/suggest?contactId=&name=&taxId= — ตัวเลือกคู่ค้าสำหรับชื่อในบิล (ไม่เลือกให้เอง) */
partnersRouter.get("/suggest", suggestPartners);

/** POST /api/partners — { contactId, displayName, taxId?, phone?, note?, aliasFrom? } */
partnersRouter.post("/", createPartner);

/** GET /api/partners/:id */
partnersRouter.get("/:id", getPartner);

/** PATCH /api/partners/:id — { displayName?, taxId?, phone?, note? } */
partnersRouter.patch("/:id", updatePartner);

/** DELETE /api/partners/:id — บิลที่ผูกอยู่กลับเป็น "ยังไม่ระบุคู่ค้า" (owner เท่านั้น) */
partnersRouter.delete("/:id", requireRole("owner"), deletePartner);

/** POST /api/partners/:id/aliases — { name } */
partnersRouter.post("/:id/aliases", addPartnerAlias);

/** DELETE /api/partners/:id/aliases/:aliasId */
partnersRouter.delete("/:id/aliases/:aliasId", deletePartnerAlias);

/** POST /api/partners/:id/merge — { fromPartnerId } รวมคู่ค้าที่ซ้ำเข้ามาที่ :id */
partnersRouter.post("/:id/merge", mergePartner);
