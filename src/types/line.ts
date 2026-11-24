// ชนิดข้อมูล webhook ของ LINE เท่าที่ระบบใช้

export interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

export interface LineEventBase {
  type: string;
  webhookEventId: string;
  deliveryContext: { isRedelivery: boolean };
  timestamp: number;
  source: { type: "user" | "group" | "room"; userId?: string };
  replyToken?: string;
}

export interface LineMessageEvent extends LineEventBase {
  type: "message";
  message: {
    id: string;
    type: "text" | "image" | "video" | "audio" | "file" | "sticker" | "location";
    text?: string;
    /** มีใน image/video/audio — "line" = ไฟล์อยู่บน LINE (ดึงผ่าน getMessageContent) */
    contentProvider?: { type: "line" | "external"; originalContentUrl?: string };
    /** มีเมื่อลูกค้าเลือกหลายรูปแล้วส่งพร้อมกัน — รูปในชุดเดียวกันมี id เดียวกัน (index เริ่ม 1) */
    imageSet?: { id: string; index: number; total: number };
    [key: string]: unknown;
  };
}

export interface LineUnsendEvent extends LineEventBase {
  type: "unsend";
  unsend: { messageId: string };
}

export type LineEvent = LineMessageEvent | LineUnsendEvent | LineEventBase;
