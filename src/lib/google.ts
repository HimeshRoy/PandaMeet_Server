import { OAuth2Client } from "google-auth-library";

export type VerifiedGoogleUser = {
  googleAccountId: string;
  email: string | null;
  displayName: string | null;
};

function getGoogleClient(): {
  client: OAuth2Client;
  clientId: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();

  if (!clientId) {
    throw new Error("Google authentication is not configured");
  }

  return {
    client: new OAuth2Client(clientId),
    clientId,
  };
}

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<VerifiedGoogleUser> {
  if (typeof idToken !== "string" || !idToken.trim()) {
    throw new Error("Google ID token is required");
  }

  const { client, clientId } = getGoogleClient();

  const ticket = await client.verifyIdToken({
    idToken: idToken.trim(),
    audience: clientId,
  });

  const payload = ticket.getPayload();

  if (!payload?.sub) {
    throw new Error("Google account identifier is missing");
  }

  /*
   * Google requires email verification
   * to be explicitly represented in the
   * token payload.
   *
   * We don't use email as the account ID.
   */
  const email = typeof payload.email === "string" ? payload.email : null;

  const displayName = typeof payload.name === "string" ? payload.name : null;

  return {
    googleAccountId: payload.sub,
    email,
    displayName,
  };
}
