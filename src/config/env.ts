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
};
