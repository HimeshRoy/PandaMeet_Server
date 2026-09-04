import crypto from "node:crypto";

import { prisma } from "./prisma";

export const SESSION_DURATION_DAYS = 30;

const SESSION_USER_SELECT = {
  id: true,
  phoneNumber: true,
  phoneVerification: true,
  phoneVerifiedAt: true,
  googleAccountId: true,
  googleEmail: true,
  displayName: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

export type AuthenticatedUser = {
  id: string;
  phoneNumber: string;
  phoneVerification: "NONE" | "SIM" | "SMS";
  phoneVerifiedAt: Date | null;
  googleAccountId: string | null;
  googleEmail: string | null;
  displayName: string;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function getSessionExpiry(): Date {
  const expiry = new Date();

  expiry.setDate(expiry.getDate() + SESSION_DURATION_DAYS);

  return expiry;
}

export async function findValidSession(sessionToken: string): Promise<{
  sessionId: string;
  user: AuthenticatedUser;
} | null> {
  if (typeof sessionToken !== "string" || !sessionToken.trim()) {
    return null;
  }

  const tokenHash = hashSessionToken(sessionToken);

  const session = await prisma.session.findUnique({
    where: {
      tokenHash,
    },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: SESSION_USER_SELECT,
      },
    },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt <= new Date()) {
    await prisma.session.deleteMany({
      where: {
        id: session.id,
      },
    });

    return null;
  }

  return {
    sessionId: session.id,
    user: session.user,
  };
}

export async function deleteSession(sessionToken: string): Promise<void> {
  if (typeof sessionToken !== "string" || !sessionToken.trim()) {
    return;
  }

  const tokenHash = hashSessionToken(sessionToken);

  await prisma.session.deleteMany({
    where: {
      tokenHash,
    },
  });
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  if (typeof userId !== "string" || !userId.trim()) {
    return;
  }

  await prisma.session.deleteMany({
    where: {
      userId,
    },
  });
}
