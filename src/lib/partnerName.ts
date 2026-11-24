// ทำชื่อคู่ค้าให้อยู่ในรูปเดียวกันก่อนเทียบ: "นายเอ", "ร้าน เอ", "บริษัท เอ จำกัด" → "เอ"

const PREFIX =
  /^(นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|คุณ|เจ๊|เฮีย|ร้าน|บริษัท|บจก\.?|หจก\.?|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|mr\.?|mrs\.?|ms\.?|miss)\s*/i;
const SUFFIX = /\s*(จำกัด\s*\(มหาชน\)|\(มหาชน\)|จำกัด|co\.?,?\s*ltd\.?|company\s+limited|limited|ltd\.?|การค้า|\(?สำนักงานใหญ่\)?|\(?สาขา[^)]*\)?)$/i;

export function normalizePartnerName(name: string): string {
  let t = name.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < 4; i++) {
    const next = t.replace(PREFIX, "").replace(SUFFIX, "").trim();
    if (next === t || !next) break;
    t = next;
  }
  return t.replace(/[\s.,'"()\-_/]/g, "");
}

/** ความคล้ายของชื่อ 0–1 (Dice coefficient บน bigram) — ใช้เรียงตัวเลือก ไม่ใช้จับคู่อัตโนมัติ */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) + 0.15;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * overlap) / total : 0;
}
