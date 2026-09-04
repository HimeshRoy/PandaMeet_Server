import { Request, Response, NextFunction } from "express";

import { findValidSession } from "../lib/session";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authHeader = req.headers.authorization;

    let sessionToken: string | undefined;

    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7).trim();

      if (token) {
        sessionToken = token;
      }
    }

    if (!sessionToken) {
      const cookieToken = req.cookies?.session;

      if (typeof cookieToken === "string" && cookieToken.trim()) {
        sessionToken = cookieToken.trim();
      }
    }

    if (!sessionToken) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const result = await findValidSession(sessionToken);

    if (!result) {
      res.clearCookie("session", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });

      return res.status(401).json({
        message: "Invalid or expired session",
      });
    }

    req.user = result.user;

    next();
  } catch (error) {
    console.error(
      "Authentication error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Authentication failed",
    });
  }
}
