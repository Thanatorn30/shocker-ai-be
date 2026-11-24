-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "ai_data" JSONB,
ADD COLUMN     "ai_read_at" TIMESTAMPTZ,
ALTER COLUMN "contact_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "partners" ALTER COLUMN "contact_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "partner_aliases" ALTER COLUMN "contact_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "bills_partner_id_bill_date_idx" ON "bills"("partner_id", "bill_date");

-- CreateIndex
CREATE INDEX "partners_tax_id_idx" ON "partners"("tax_id");

-- CreateIndex
CREATE INDEX "partner_aliases_alias_idx" ON "partner_aliases"("alias");

