import { Router } from "express";
import { conversationsRouter } from "./conversations.js";
import { adminsRouter } from "./admins.js";
import { authRouter } from "./auth.js";
import { lineRouter } from "./line.js";
import { messagesRouter } from "./messages.js";
import { receiptsRouter } from "./receipts.js";
import { billsRouter } from "./bills.js";
import { partnersRouter } from "./partners.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/conversations", conversationsRouter); 
apiRouter.use("/admins", adminsRouter); 
apiRouter.use("/messages", messagesRouter); 
apiRouter.use("/line", lineRouter); 
apiRouter.use("/receipts", receiptsRouter); // ลิงก์รูปบิล (ลายเซ็นในลิงก์ ไม่ต้อง login)
apiRouter.use("/bills", billsRouter);
apiRouter.use("/partners", partnersRouter);
