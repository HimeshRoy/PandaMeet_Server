/*
  Warnings:

  - You are about to drop the `OtpCode` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PhoneVerificationMethod" AS ENUM ('NONE', 'SIM', 'SMS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneVerification" "PhoneVerificationMethod" NOT NULL DEFAULT 'NONE';

-- DropTable
DROP TABLE "OtpCode";
