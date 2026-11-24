import type { Writable } from "node:stream";
import ExcelJS from "exceljs";

// สร้างไฟล์ .xlsx รายงานบิลแบบ stream (เขียนทีละแถวลง response — ไม่ถือทั้งไฟล์ในหน่วยความจำ)
// - แผ่น "บิล": 1 บิล = 1 แถว + แถวรวมท้ายตาราง (รวมบิลซื้อ / รวมบิลขาย / รวมทั้งหมด)
// - แผ่น "รายการสินค้า": 1 รายการ = 1 แถว + แถวรวม
// ตัวเลขเป็น number, วันที่เป็นวันที่จริงของ Excel, สูตรรวมใส่ค่าที่คำนวณไว้แล้ว (เปิดแล้วเห็นผลทันที แม้โปรแกรมไม่คำนวณใหม่)

export type ExportBillItem = {
  lineNo: number;
  name: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
};

export type ExportBill = {
  billDate: Date | null;
  direction: "purchase" | "sale";
  docType: string;
  billNo: string | null;
  partnerName: string | null;
  partnerNameRaw: string | null;
  partnerTaxId: string | null;
  subtotal: number | null;
  discount: number | null;
  vat: number | null;
  total: number | null;
  paidAmount: number;
  currency: string;
  paymentMethod: string | null;
  status: string;
  note: string | null;
  createdAt: Date;
  items: ExportBillItem[];
};

const DIRECTION_LABEL = { purchase: "บิลซื้อ", sale: "บิลขาย" } as const;
const DOC_TYPE_LABEL: Record<string, string> = {
  delivery_note: "ใบส่งของ",
  receipt: "ใบเสร็จรับเงิน",
  tax_invoice: "ใบกำกับภาษี",
  invoice: "ใบแจ้งหนี้ / ใบวางบิล",
  other: "อื่นๆ",
};

const MONEY = "#,##0.00";
const QTY = "#,##0.###";
const DATE = "dd/mm/yyyy";
const MAX_TEXT = 32_000; // Excel รับข้อความได้ไม่เกิน 32,767 ตัวอักษรต่อช่อง

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE8F5EE" },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF4F4F5" },
};
// ปิดเส้นตารางของ Excel แล้วตีเส้นเฉพาะช่องที่มีข้อมูล (ไม่มีเส้นเผื่อในช่องว่าง)
const LINE = { style: "thin", color: { argb: "FFD4D4D8" } } as const;
const CELL_BORDER: Partial<ExcelJS.Borders> = {
  top: LINE,
  left: LINE,
  bottom: LINE,
  right: LINE,
};
const GRAND_BORDER: Partial<ExcelJS.Borders> = {
  ...CELL_BORDER,
  top: { style: "thin", color: { argb: "FF71717A" } },
};

/** ตีเส้น + รูปแบบตัวเลขให้ช่องที่ 1..colCount ของแถว (ใส่ทีละช่อง ไม่ตั้งทั้งคอลัมน์) */
function frameRow(
  row: ExcelJS.Row,
  colCount: number,
  numFmts: Record<number, string>,
  border = CELL_BORDER,
) {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.border = border;
    if (numFmts[c]) cell.numFmt = numFmts[c];
  }
}

/** numFmt ของแต่ละคอลัมน์ (เลขคอลัมน์ → รูปแบบ) จากรายการคอลัมน์ */
function numFmtMap(cols: { fmt?: string }[]): Record<number, string> {
  const m: Record<number, string> = {};
  cols.forEach((c, i) => {
    if (c.fmt) m[i + 1] = c.fmt;
  });
  return m;
}

const text = (v: string | null | undefined) =>
  v ? v.slice(0, MAX_TEXT) : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** เลขคอลัมน์ → ตัวอักษร (1 → A) */
function col(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function styleHeader(row: ExcelJS.Row, colCount: number) {
  row.font = { bold: true };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 30;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = HEADER_FILL;
    cell.border = CELL_BORDER;
  }
}

/**
 * แถวรวม: label อยู่คอลัมน์ labelCol, คอลัมน์เงินใช้สูตร SUM/SUMIF พร้อมค่าที่คำนวณไว้แล้ว
 * filter = คอลัมน์ประเภทบิล + ค่าที่ต้องการ (ไม่ใส่ = รวมทั้งหมด)
 */
function addTotalRow(
  sheet: ExcelJS.Worksheet,
  opts: {
    label: string;
    labelCol: number;
    firstRow: number;
    lastRow: number;
    sums: { colIndex: number; values: (number | null)[] }[];
    match: boolean[]; // แถวไหนนับในผลรวมนี้ (ตามลำดับข้อมูล)
    filter?: { colIndex: number; value: string };
    count?: { colIndex: number };
    last?: boolean;
    colCount: number;
  },
) {
  const { firstRow, lastRow } = opts;
  const hasData = lastRow >= firstRow;
  const values: Record<number, ExcelJS.CellValue> = {
    [opts.labelCol]: opts.label,
  };

  for (const s of opts.sums) {
    const result = round2(
      s.values.reduce<number>(
        (acc, v, i) => (opts.match[i] && v !== null ? acc + v : acc),
        0,
      ),
    );
    const range = `${col(s.colIndex)}${firstRow}:${col(s.colIndex)}${lastRow}`;
    const formula = !hasData
      ? undefined
      : opts.filter
        ? `SUMIF(${col(opts.filter.colIndex)}${firstRow}:${col(opts.filter.colIndex)}${lastRow},"${opts.filter.value}",${range})`
        : `SUM(${range})`;
    values[s.colIndex] = formula ? { formula, result } : result;
  }
  if (opts.count) {
    const n = opts.match.filter(Boolean).length;
    values[opts.count.colIndex] = `${n.toLocaleString("en-US")} ใบ`;
  }

  // ใส่ค่าทีละช่องตามเลขคอลัมน์ (addRow({...}) ของ exceljs ใช้ key เป็นชื่อคอลัมน์ ไม่ใช่เลข)
  const row = sheet.addRow([]);
  for (const [c, v] of Object.entries(values)) row.getCell(Number(c)).value = v;
  row.font = { bold: true };
  for (let c = 1; c <= opts.colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = TOTAL_FILL;
    cell.border = opts.last ? GRAND_BORDER : CELL_BORDER;
  }
  for (const s of opts.sums) row.getCell(s.colIndex).numFmt = MONEY;
  row.commit();
}

/**
 * เขียนรายงานบิลลง stream — bills = async iterable ที่คืนบิลเป็นชุด (เรียงตามวันที่แล้ว)
 * คืนจำนวนบิล/รายการที่เขียน
 */
export async function writeBillsXlsx(
  stream: Writable,
  bills: AsyncIterable<ExportBill[]>,
  meta: {
    title: string;
    from: Date | null;
    to: Date | null;
    generatedAt?: Date;
    direction?: "purchase" | "sale";
  },
): Promise<{ bills: number; items: number }> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  wb.creator = "shocker-ai";
  wb.created = meta.generatedAt ?? new Date();

  // ───────── แผ่น "บิล" ─────────
  const sheet = wb.addWorksheet("บิล", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
    },
  });
  const billCols = [
    { header: "ลำดับ", key: "no", width: 7 },
    { header: "วันที่ในบิล", key: "billDate", width: 12, fmt: DATE },
    { header: "ประเภทบิล", key: "direction", width: 10 },
    { header: "ประเภทเอกสาร", key: "docType", width: 18 },
    { header: "เลขที่บิล", key: "billNo", width: 16 },
    { header: "คู่ค้า", key: "partner", width: 28 },
    { header: "ชื่อตามบิล", key: "partnerNameRaw", width: 28 },
    { header: "เลขผู้เสียภาษี", key: "taxId", width: 16 },
    { header: "ยอดก่อน VAT", key: "subtotal", width: 14, fmt: MONEY },
    { header: "ส่วนลด", key: "discount", width: 12, fmt: MONEY },
    { header: "VAT", key: "vat", width: 12, fmt: MONEY },
    { header: "ยอดสุทธิ", key: "total", width: 14, fmt: MONEY },
    { header: "หมายเหตุ", key: "note", width: 36 },
    { header: "วันที่บันทึก", key: "createdAt", width: 12, fmt: DATE },
  ];
  sheet.columns = billCols.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));
  const BILL_COLS = billCols.length;
  const billFmts = numFmtMap(billCols);
  styleHeader(sheet.getRow(1), BILL_COLS);
  sheet.getRow(1).commit();

  const C = (key: string) => sheet.getColumn(key).number;
  const money = ["subtotal", "discount", "vat", "total"] as const;
  const moneyValues: Record<(typeof money)[number], (number | null)[]> = {
    subtotal: [],
    discount: [],
    vat: [],
    total: [],
  };
  const directions: BillDirectionLabel[] = [];
  type BillDirectionLabel =
    (typeof DIRECTION_LABEL)[keyof typeof DIRECTION_LABEL];

  // รายการสินค้าเก็บไว้เขียนแผ่นที่ 2 (แผ่นแบบ stream ต้องเขียนทีละแผ่น)
  const itemRows: (ExportBillItem & { billNo: number; bill: ExportBill })[] =
    [];

  let n = 0;
  for await (const batch of bills) {
    for (const b of batch) {
      n++;
      const row = sheet.addRow({
        no: n,
        billDate: b.billDate,
        direction: DIRECTION_LABEL[b.direction],
        docType: DOC_TYPE_LABEL[b.docType] ?? b.docType,
        billNo: text(b.billNo),
        partner: text(b.partnerName),
        partnerNameRaw: text(b.partnerNameRaw),
        taxId: text(b.partnerTaxId),
        subtotal: b.subtotal,
        discount: b.discount,
        vat: b.vat,
        total: b.total,
        note: text(b.note),
        createdAt: b.createdAt,
      });
      frameRow(row, BILL_COLS, billFmts);
      row.commit();

      moneyValues.subtotal.push(b.subtotal);
      moneyValues.discount.push(b.discount);
      moneyValues.vat.push(b.vat);
      moneyValues.total.push(b.total);
      directions.push(DIRECTION_LABEL[b.direction]);
      for (const it of b.items) itemRows.push({ ...it, billNo: n, bill: b });
    }
  }

  const firstRow = 2;
  const lastRow = n + 1;
  // export ทั้งซื้อและขาย → แถวรวมแยกประเภท + รวมทั้งหมด / export ประเภทเดียว → รวมบรรทัดเดียว
  const splitRows = meta.direction
    ? []
    : ([
        ["รวมบิลซื้อ", DIRECTION_LABEL.purchase],
        ["รวมบิลขาย", DIRECTION_LABEL.sale],
      ] as const);
  const grandLabel = meta.direction
    ? `รวม${DIRECTION_LABEL[meta.direction]}`
    : "รวมทั้งหมด";
  const sums = money.map((k) => ({ colIndex: C(k), values: moneyValues[k] }));
  for (const [label, dir] of splitRows) {
    addTotalRow(sheet, {
      label,
      labelCol: C("partner"),
      firstRow,
      lastRow,
      sums,
      match: directions.map((d) => d === dir),
      filter: { colIndex: C("direction"), value: dir },
      count: { colIndex: C("billNo") },
      colCount: BILL_COLS,
    });
  }
  addTotalRow(sheet, {
    label: grandLabel,
    labelCol: C("partner"),
    firstRow,
    lastRow,
    sums,
    match: directions.map(() => true),
    count: { colIndex: C("billNo") },
    last: true,
    colCount: BILL_COLS,
  });
  if (n > 0)
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: lastRow, column: BILL_COLS },
    };
  sheet.commit();

  // ───────── แผ่น "รายการสินค้า" ─────────
  const items = wb.addWorksheet("รายการสินค้า", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  const itemCols = [
    { header: "ลำดับบิล", key: "billNo", width: 9 },
    { header: "วันที่ในบิล", key: "billDate", width: 12, fmt: DATE },
    { header: "ประเภทบิล", key: "direction", width: 10 },
    { header: "เลขที่บิล", key: "docNo", width: 16 },
    { header: "คู่ค้า", key: "partner", width: 28 },
    { header: "ลำดับ", key: "lineNo", width: 7 },
    { header: "รายการ", key: "name", width: 36 },
    { header: "จำนวน", key: "quantity", width: 10, fmt: QTY },
    { header: "หน่วย", key: "unit", width: 10 },
    { header: "ราคา/หน่วย", key: "unitPrice", width: 13, fmt: MONEY },
    { header: "จำนวนเงิน", key: "amount", width: 14, fmt: MONEY },
  ];
  items.columns = itemCols.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));
  const ITEM_COLS = itemCols.length;
  const itemFmts = numFmtMap(itemCols);
  styleHeader(items.getRow(1), ITEM_COLS);
  items.getRow(1).commit();
  const I = (key: string) => items.getColumn(key).number;

  // จำนวนเงินว่าง แต่มีจำนวน + ราคาต่อหน่วย → คำนวณให้ (ให้แถวรวมถูกต้อง)
  for (const it of itemRows) {
    if (it.amount === null && it.quantity !== null && it.unitPrice !== null) it.amount = round2(it.quantity * it.unitPrice);
  }
  for (const it of itemRows) {
    const row = items.addRow({
      billNo: it.billNo,
      billDate: it.bill.billDate,
      direction: DIRECTION_LABEL[it.bill.direction],
      docNo: text(it.bill.billNo),
      partner: text(it.bill.partnerName ?? it.bill.partnerNameRaw),
      lineNo: it.lineNo,
      name: text(it.name),
      quantity: it.quantity,
      unit: text(it.unit),
      unitPrice: it.unitPrice,
      amount: it.amount,
    });
    frameRow(row, ITEM_COLS, itemFmts);
    row.commit();
  }
  const itemLast = itemRows.length + 1;
  const itemSums = [
    { colIndex: I("amount"), values: itemRows.map((it) => it.amount) },
  ];
  for (const [label, dir] of splitRows) {
    addTotalRow(items, {
      label,
      labelCol: I("name"),
      firstRow: 2,
      lastRow: itemLast,
      sums: itemSums,
      match: itemRows.map((it) => DIRECTION_LABEL[it.bill.direction] === dir),
      filter: { colIndex: I("direction"), value: dir },
      colCount: ITEM_COLS,
    });
  }
  addTotalRow(items, {
    label: grandLabel,
    labelCol: I("name"),
    firstRow: 2,
    lastRow: itemLast,
    sums: itemSums,
    match: itemRows.map(() => true),
    last: true,
    colCount: ITEM_COLS,
  });
  if (itemRows.length > 0)
    items.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: itemLast, column: ITEM_COLS },
    };
  items.commit();

  // ───────── แผ่น "ข้อมูลการส่งออก" ─────────
  const info = wb.addWorksheet("ข้อมูลการส่งออก", {
    views: [{ showGridLines: false }],
  });
  info.columns = [
    { key: "k", width: 22 },
    { key: "v", width: 40 },
  ];
  const fmt = (d: Date | null) =>
    d
      ? d.toLocaleDateString("th-TH", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "-";
  for (const [k, v] of [
    ["รายงาน", meta.title],
    [
      "ประเภทบิล",
      meta.direction ? DIRECTION_LABEL[meta.direction] : "บิลซื้อและบิลขาย",
    ],
    ["ตั้งแต่วันที่", fmt(meta.from)],
    ["ถึงวันที่", fmt(meta.to)],
    ["จำนวนบิล", n],
    ["จำนวนรายการสินค้า", itemRows.length],
    [
      "ส่งออกเมื่อ",
      (meta.generatedAt ?? new Date()).toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
        dateStyle: "long",
        timeStyle: "short",
      }),
    ],
    ["หมายเหตุ", "ยอดรวมอยู่บรรทัดท้ายของแผ่น “บิล” และ “รายการสินค้า”"],
  ] as const) {
    const row = info.addRow({ k, v });
    row.getCell(1).font = { bold: true };
    frameRow(row, 2, {});
    row.commit();
  }
  info.commit();

  await wb.commit();
  return { bills: n, items: itemRows.length };
}
