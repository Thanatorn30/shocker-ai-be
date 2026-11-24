-- CreateEnum
CREATE TYPE "BillDirection" AS ENUM ('purchase', 'sale');

-- CreateEnum
CREATE TYPE "BillDocType" AS ENUM ('delivery_note', 'receipt', 'tax_invoice', 'invoice', 'other');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('draft', 'confirmed', 'void');

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "direction" "BillDirection" NOT NULL,
    "doc_type" "BillDocType" NOT NULL DEFAULT 'other',
    "status" "BillStatus" NOT NULL DEFAULT 'draft',
    "bill_no" VARCHAR(100),
    "bill_date" DATE,
    "partner_name_raw" VARCHAR(255),
    "partner_tax_id_raw" VARCHAR(13),
    "partner_id" UUID,
    "subtotal" DECIMAL(12,2),
    "discount" DECIMAL(12,2),
    "vat" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'THB',
    "payment_method" VARCHAR(30),
    "note" TEXT,
    "confirmed_at" TIMESTAMPTZ,
    "sheet_synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_items" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "name" VARCHAR(255),
    "quantity" DECIMAL(12,3),
    "unit" VARCHAR(30),
    "unit_price" DECIMAL(12,2),
    "amount" DECIMAL(12,2),

    CONSTRAINT "bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_images" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "image_key" VARCHAR(255),
    "extraction_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "tax_id" VARCHAR(13),
    "phone" VARCHAR(20),
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_aliases" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "alias" VARCHAR(255) NOT NULL,
    "raw_name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bills_contact_id_bill_date_idx" ON "bills"("contact_id", "bill_date");

-- CreateIndex
CREATE INDEX "bills_contact_id_partner_id_bill_date_idx" ON "bills"("contact_id", "partner_id", "bill_date");

-- CreateIndex
CREATE INDEX "bills_contact_id_bill_no_idx" ON "bills"("contact_id", "bill_no");

-- CreateIndex
CREATE INDEX "bills_contact_id_status_idx" ON "bills"("contact_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bill_items_bill_id_line_no_key" ON "bill_items"("bill_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "bill_images_extraction_id_key" ON "bill_images"("extraction_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_images_bill_id_position_key" ON "bill_images"("bill_id", "position");

-- CreateIndex
CREATE INDEX "partners_contact_id_display_name_idx" ON "partners"("contact_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "partners_contact_id_tax_id_key" ON "partners"("contact_id", "tax_id");

-- CreateIndex
CREATE INDEX "partner_aliases_partner_id_idx" ON "partner_aliases"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_aliases_contact_id_alias_key" ON "partner_aliases"("contact_id", "alias");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_images" ADD CONSTRAINT "bill_images_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_images" ADD CONSTRAINT "bill_images_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "receipt_extractions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_aliases" ADD CONSTRAINT "partner_aliases_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_aliases" ADD CONSTRAINT "partner_aliases_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

