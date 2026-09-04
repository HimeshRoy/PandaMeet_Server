import { Request, Response, Router } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { prisma } from "../lib/prisma";
import { verifyGoogleIdToken } from "../lib/google";
import { createAuthSession } from "../lib/auth-session";
import { deleteSession } from "../lib/session";
import { requireAuth } from "../middleware/auth";

const router = Router();

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_GOOGLE_ID_TOKEN_LENGTH = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 80;

const USER_SELECT = {
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

function normalizeIndianPhone(phoneNumber: unknown): string | null {
  if (typeof phoneNumber !== "string") {
    return null;
  }

  const value = phoneNumber.trim();

  if (!value) {
    return null;
  }

  const parsedPhone = parsePhoneNumberFromString(value, "IN");

  if (!parsedPhone || !parsedPhone.isValid()) {
    return null;
  }

  if (parsedPhone.country !== "IN") {
    return null;
  }

  return parsedPhone.number;
}

function normalizeDisplayName(displayName: unknown): string | null {
  if (typeof displayName !== "string") {
    return null;
  }

  const value = displayName.trim();

  if (!value || value.length > MAX_DISPLAY_NAME_LENGTH) {
    return null;
  }

  return value;
}

function setSessionCookie(res: Response, sessionToken: string): void {
  res.cookie("session", sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

function getSessionToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (token) {
      return token;
    }
  }

  const cookieToken = req.cookies?.session;

  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return cookieToken.trim();
  }

  return undefined;
}

function getGoogleDisplayName(googleDisplayName: string | null): string {
  return normalizeDisplayName(googleDisplayName) ?? "PandaMeet user";
}

/**
 * Google authentication with a PandaMeet phone number.
 *
 * Authentication flow:
 *
 * 1. Mobile app collects the user's Indian phone number.
 *
 * 2. Mobile app completes Google Sign-In.
 *
 * 3. Mobile app sends the Google ID token and phone number
 *    to this endpoint.
 *
 * 4. Server independently verifies the Google ID token.
 *
 * 5. The Google account and phone number must belong to
 *    the same PandaMeet account.
 *
 * 6. Server creates or retrieves the PandaMeet account.
 *
 * 7. Server creates a secure session.
 *
 * Important:
 * The phone number identifies the PandaMeet account but is
 * not independently verified by SMS or SIM in this flow.
 */
router.post("/google", async (req, res) => {
  try {
    const { idToken, phoneNumber, displayName } = req.body ?? {};

    /*
     * Validate Google ID token input.
     */
    if (typeof idToken !== "string" || !idToken.trim()) {
      return res.status(400).json({
        message: "Google authentication is required",
      });
    }

    if (idToken.length > MAX_GOOGLE_ID_TOKEN_LENGTH) {
      return res.status(400).json({
        message: "Invalid Google authentication data",
      });
    }

    /*
     * Normalize and validate the Indian phone number.
     */
    const normalizedPhone = normalizeIndianPhone(phoneNumber);

    if (!normalizedPhone) {
      return res.status(400).json({
        message: "Please enter a valid Indian phone number",
      });
    }

    /*
     * Verify the Google ID token on the server.
     *
     * Never trust Google account information supplied
     * directly by the mobile client.
     */
    const googleUser = await verifyGoogleIdToken(idToken);

    /*
     * First check whether this Google account already
     * belongs to a PandaMeet account.
     */
    const existingGoogleUser = await prisma.user.findUnique({
      where: {
        googleAccountId: googleUser.googleAccountId,
      },
      select: USER_SELECT,
    });

    /*
     * Existing Google account.
     */
    if (existingGoogleUser) {
      /*
       * A Google account cannot silently change the
       * PandaMeet phone number associated with it.
       */
      if (existingGoogleUser.phoneNumber !== normalizedPhone) {
        return res.status(409).json({
          message:
            "This Google account is already linked to a different PandaMeet phone number",
        });
      }

      /*
       * Update Google profile information and last-seen time.
       *
       * Phone verification is intentionally not changed here.
       * This authentication flow does not verify phone ownership.
       */
      const updatedUser = await prisma.user.update({
        where: {
          id: existingGoogleUser.id,
        },
        data: {
          googleEmail: googleUser.email ?? existingGoogleUser.googleEmail,
          lastSeenAt: new Date(),
        },
        select: USER_SELECT,
      });

      /*
       * Create a new session for this login.
       *
       * Existing sessions are intentionally preserved
       * so the same account can remain signed in on
       * multiple devices.
       */
      const sessionToken = await createAuthSession(updatedUser.id);

      setSessionCookie(res, sessionToken);

      return res.status(200).json({
        message: "Signed in successfully",
        isNewUser: false,
        user: updatedUser,
        sessionToken,
      });
    }

    /*
     * Google account is new.
     *
     * Check whether the phone number already belongs
     * to another PandaMeet account.
     */
    const existingPhoneUser = await prisma.user.findUnique({
      where: {
        phoneNumber: normalizedPhone,
      },
      select: {
        id: true,
        googleAccountId: true,
      },
    });

    if (existingPhoneUser) {
      return res.status(409).json({
        message:
          "An account with this phone number already exists. Please use the Google account already linked to PandaMeet.",
      });
    }

    /*
     * Determine the initial display name.
     *
     * Prefer a valid name supplied by the app.
     * Otherwise use Google's verified display name.
     * Finally fall back to a generic PandaMeet name.
     */
    const requestedName = normalizeDisplayName(displayName);

    const userName =
      requestedName ?? getGoogleDisplayName(googleUser.displayName);

    /*
     * Create the PandaMeet account.
     *
     * Phone verification remains NONE because this
     * authentication flow does not verify ownership of
     * the phone number through SIM or SMS.
     */
    const user = await prisma.user.create({
      data: {
        phoneNumber: normalizedPhone,

        phoneVerification: "NONE",

        phoneVerifiedAt: null,

        googleAccountId: googleUser.googleAccountId,

        googleEmail: googleUser.email,

        displayName: userName,

        lastSeenAt: new Date(),
      },

      select: USER_SELECT,
    });

    /*
     * Create the authenticated session.
     */
    const sessionToken = await createAuthSession(user.id);

    setSessionCookie(res, sessionToken);

    return res.status(201).json({
      message: "Account created successfully",
      isNewUser: true,
      user,
      sessionToken,
    });
  } catch (error) {
    /*
     * Never log ID tokens, session tokens,
     * phone numbers, or request bodies.
     */
    console.error(
      "Google authentication error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not complete Google authentication",
    });
  }
});

/**
 * Get the currently authenticated user.
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const user = await prisma.user.update({
      where: {
        id: req.user.id,
      },
      data: {
        lastSeenAt: new Date(),
      },
      select: USER_SELECT,
    });

    return res.status(200).json({
      user,
    });
  } catch (error) {
    console.error(
      "Get current user error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not get account information",
    });
  }
});

/**
 * Log out the current session.
 */
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const sessionToken = getSessionToken(req);

    if (sessionToken) {
      await deleteSession(sessionToken);
    }

    res.clearCookie("session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });

    return res.status(200).json({
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error(
      "Logout error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not log out",
    });
  }
});

export default router;
