import { Router } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_CONTACTS_PER_REQUEST = 500;
const MAX_PUSH_TOKEN_LENGTH = 512;

const USER_SELECT = {
  id: true,
  phoneNumber: true,
  displayName: true,
  lastSeenAt: true,
} as const;

function normalizeIndianPhone(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const phone = parsePhoneNumberFromString(trimmedValue, "IN");

  if (!phone || !phone.isValid()) {
    return null;
  }

  if (phone.country !== "IN") {
    return null;
  }

  return phone.number;
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const name = value.trim();

  if (!name || name.length > MAX_DISPLAY_NAME_LENGTH) {
    return null;
  }

  return name;
}

function normalizePushToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const token = value.trim();

  if (!token || token.length > MAX_PUSH_TOKEN_LENGTH) {
    return null;
  }

  if (!token.startsWith("ExponentPushToken[")) {
    return null;
  }

  if (!token.endsWith("]")) {
    return null;
  }

  return token;
}

/**
 * Get the currently authenticated user's profile.
 *
 * GET /api/users/me
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.user.id,
      },
      select: {
        id: true,
        phoneNumber: true,
        phoneVerification: true,
        phoneVerifiedAt: true,
        googleAccountId: true,
        googleEmail: true,
        displayName: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    return res.status(200).json({
      user,
    });
  } catch (error) {
    console.error(
      "Get user profile error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not get user profile",
    });
  }
});

/**
 * Update the authenticated user's display name.
 *
 * PATCH /api/users/me
 */
router.patch("/me", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const displayName = normalizeDisplayName(req.body?.displayName);

    if (!displayName) {
      return res.status(400).json({
        message: "Please enter a valid display name",
      });
    }

    const user = await prisma.user.update({
      where: {
        id: req.user.id,
      },
      data: {
        displayName,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        phoneNumber: true,
        displayName: true,
        lastSeenAt: true,
      },
    });

    return res.status(200).json({
      message: "Profile updated successfully",
      user,
    });
  } catch (error) {
    console.error(
      "Update user profile error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not update profile",
    });
  }
});

/**
 * Register or update the authenticated user's
 * Expo push notification token.
 *
 * POST /api/users/me/push-token
 */
router.post("/me/push-token", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const pushToken = normalizePushToken(req.body?.pushToken);

    console.log("PandaMeet push token received:", Boolean(pushToken));

    if (!pushToken) {
      return res.status(400).json({
        message: "A valid push token is required",
      });
    }

    await prisma.user.update({
      where: {
        id: req.user.id,
      },
      data: {
        pushToken,
        lastSeenAt: new Date(),
      },
    });

    return res.status(200).json({
      message: "Push notification token registered",
    });
  } catch (error) {
    console.error(
      "Register push token error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not register push notification token",
    });
  }
});

/**
 * Match local contacts against PandaMeet accounts.
 *
 * The request may contain up to 500 phone numbers.
 *
 * POST /api/users/match-contacts
 */
router.post("/match-contacts", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const { phoneNumbers } = req.body ?? {};

    if (!Array.isArray(phoneNumbers)) {
      return res.status(400).json({
        message: "phoneNumbers must be an array",
      });
    }

    if (phoneNumbers.length > MAX_CONTACTS_PER_REQUEST) {
      return res.status(400).json({
        message: "You can match up to 500 contacts at once",
      });
    }

    const normalizedNumbers = phoneNumbers
      .map(normalizeIndianPhone)
      .filter((phone): phone is string => phone !== null);

    const uniqueNumbers = Array.from(new Set(normalizedNumbers));

    if (uniqueNumbers.length === 0) {
      return res.status(200).json({
        users: [],
      });
    }

    const users = await prisma.user.findMany({
      where: {
        phoneNumber: {
          in: uniqueNumbers,
        },
        id: {
          not: req.user.id,
        },
      },
      select: USER_SELECT,
      orderBy: {
        displayName: "asc",
      },
    });

    return res.status(200).json({
      users,
    });
  } catch (error) {
    console.error(
      "Match contacts error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not match contacts",
    });
  }
});

export default router;
