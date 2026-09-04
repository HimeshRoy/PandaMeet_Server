/*
  Warnings:

  - A unique constraint covering the columns `[googleAccountId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleAccountId" TEXT,
ADD COLUMN     "googleEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleAccountId_key" ON "User"("googleAccountId");
