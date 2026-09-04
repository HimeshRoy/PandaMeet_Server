import type { AuthenticatedUser } from "../lib/session";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
