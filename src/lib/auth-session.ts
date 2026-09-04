import { prisma } from "./prisma";
import {
  generateSessionToken,
  getSessionExpiry,
  hashSessionToken,
} from "./session";

export async function createAuthSession(userId: string): Promise<string> {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("User ID is required");
  }

  const sessionToken = generateSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = getSessionExpiry();

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  return sessionToken;
}
