import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";

let client: GoogleGenAI | undefined;

/** สร้าง client ตอนเรียกใช้ครั้งแรก (server ยังรันได้แม้ยังไม่ได้ตั้ง GEMINI_API_KEY) */
export function gemini(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: env.gemini.apiKey() });
  return client;
}
