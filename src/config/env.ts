import "dotenv/config";

function required(name: string): string {
  // trim — กันช่องว่าง/ขึ้นบรรทัดใหม่ที่ติดมาตอน copy ใส่ Render (ทำให้ signature ไม่ตรง)
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  databaseUrl: () => required("DATABASE_URL"),
  jwt: {
    secret: () => required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  },
  line: {
    channelSecret: () => required("LINE_CHANNEL_SECRET"),
    channelAccessToken: () => required("LINE_CHANNEL_ACCESS_TOKEN"),
  },
  // ส่งรูปใบเสร็จมา → บอทตอบสรุปกลับทาง LINE อัตโนมัติ (ปิดด้วย RECEIPT_AUTO_REPLY=false)
  receiptAutoReply: process.env.RECEIPT_AUTO_REPLY?.trim().toLowerCase() !== "false",
  gemini: {
    apiKey: () => required("GEMINI_API_KEY"),
    // ลองตามลำดับ — ตัวแรกล่ม/คนใช้เยอะ (503/429) จะใช้ตัวถัดไป; ตั้งเองได้ เช่น GEMINI_MODELS=gemini-3.8-flash,gemini-3.6-flash
    models: (process.env.GEMINI_MODELS ?? "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  },
  // ผลอ่านใบเสร็จ → Google Sheet (Service Account) — ไม่ได้ตั้ง env ครบ = ปิดฟีเจอร์นี้ ไม่ทำให้ server ล่ม
  sheets: {
    email: process.env.GOOGLE_SA_EMAIL?.trim() ?? "",
    // ใน .env/Render key มักมาเป็น \n แบบตัวอักษร → แปลงเป็นขึ้นบรรทัดจริง
    privateKey: (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n"),
    sheetId: process.env.GOOGLE_SHEET_ID?.trim() ?? "",
    tab: process.env.GOOGLE_SHEET_TAB?.trim() || "receipts",
  },
};

export const sheetsEnabled = () => Boolean(env.sheets.email && env.sheets.privateKey && env.sheets.sheetId);
