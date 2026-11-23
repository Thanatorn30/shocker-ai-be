-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('processing', 'done', 'not_receipt', 'failed');

-- CreateTable
CREATE TABLE "receipt_extractions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'processing',
    "model" VARCHAR(100),
    "data" JSONB,
    "merchant_name" VARCHAR(255),
    "receipt_no" VARCHAR(100),
    "receipt_date" DATE,
    "total_amount" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sheet_synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "receipt_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_extractions_message_id_key" ON "receipt_extractions"("message_id");

-- CreateIndex
CREATE INDEX "receipt_extractions_status_idx" ON "receipt_extractions"("status");

-- AddForeignKey
ALTER TABLE "receipt_extractions" ADD CONSTRAINT "receipt_extractions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
