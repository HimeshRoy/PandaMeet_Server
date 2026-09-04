import { findValidSession } from "./session";

export async function authenticateSocket(sessionToken: string) {
  if (typeof sessionToken !== "string" || !sessionToken.trim()) {
    return null;
  }

  const result = await findValidSession(sessionToken);

  if (!result) {
    return null;
  }

  return result.user;
}
