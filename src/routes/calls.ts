import { Router } from "express";
import type { Request } from "express";
import type { Server } from "socket.io";
import { sendIncomingCallPush } from "../lib/push";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

let io: Server | null = null;

const RING_TIMEOUT_MS = 30_000;
const CALL_EXPIRY_INTERVAL_MS = 5_000;

const CALL_SELECT = {
  id: true,
  callerId: true,
  receiverId: true,
  status: true,
  createdAt: true,
  startedAt: true,
  answeredAt: true,
  endedAt: true,
  caller: {
    select: {
      id: true,
      displayName: true,
      lastSeenAt: true,
    },
  },
  receiver: {
    select: {
      id: true,
      displayName: true,
      lastSeenAt: true,
      pushToken: true,
    },
  },
} as const;

export function setCallSocketServer(socketServer: Server): void {
  io = socketServer;
}

function getUserId(req: Request): string {
  if (!req.user) {
    throw new Error("Authenticated user is missing");
  }

  return req.user.id;
}

function getCallId(req: Request): string | null {
  const { id } = req.params;

  if (typeof id !== "string" || !id.trim()) {
    return null;
  }

  return id.trim();
}

function emitToUser(
  userId: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

/**
 * Convert one expired ringing call into MISSED.
 *
 * The conditional update makes this safe if another
 * request or the background expiry scheduler tries
 * to expire the same call at the same time.
 */
async function markCallMissedIfExpired(callId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - RING_TIMEOUT_MS);

  const now = new Date();

  const result = await prisma.call.updateMany({
    where: {
      id: callId,
      status: "RINGING",
      createdAt: {
        lte: cutoff,
      },
    },
    data: {
      status: "MISSED",
      endedAt: now,
    },
  });

  if (result.count !== 1) {
    return false;
  }

  const call = await prisma.call.findUnique({
    where: {
      id: callId,
    },
    select: {
      id: true,
      callerId: true,
      receiverId: true,
    },
  });

  if (!call) {
    return true;
  }

  emitToUser(call.callerId, "call-missed", {
    callId: call.id,
  });

  emitToUser(call.receiverId, "call-missed", {
    callId: call.id,
  });

  return true;
}

/**
 * Automatically expire ringing calls.
 *
 * This runs independently of API requests so a call
 * that nobody touches still becomes MISSED after
 * the 30-second ringing period.
 *
 * No call data or user data is logged.
 */
let expiryJobRunning = false;

async function expireRingingCalls(): Promise<void> {
  if (expiryJobRunning) {
    return;
  }

  expiryJobRunning = true;

  try {
    const cutoff = new Date(Date.now() - RING_TIMEOUT_MS);

    const expiredCalls = await prisma.call.findMany({
      where: {
        status: "RINGING",
        createdAt: {
          lte: cutoff,
        },
      },
      select: {
        id: true,
        callerId: true,
        receiverId: true,
      },
      take: 100,
      orderBy: {
        createdAt: "asc",
      },
    });

    if (expiredCalls.length === 0) {
      return;
    }

    for (const call of expiredCalls) {
      const result = await prisma.call.updateMany({
        where: {
          id: call.id,
          status: "RINGING",
          createdAt: {
            lte: cutoff,
          },
        },
        data: {
          status: "MISSED",
          endedAt: new Date(),
        },
      });

      if (result.count !== 1) {
        continue;
      }

      emitToUser(call.callerId, "call-missed", {
        callId: call.id,
      });

      emitToUser(call.receiverId, "call-missed", {
        callId: call.id,
      });
    }
  } catch (error) {
    console.error(
      "Call expiry job error:",
      error instanceof Error ? error.message : "Unknown error",
    );
  } finally {
    expiryJobRunning = false;
  }
}

const callExpiryTimer = setInterval(() => {
  void expireRingingCalls();
}, CALL_EXPIRY_INTERVAL_MS);

callExpiryTimer.unref?.();

/**
 * Create a new outgoing call.
 *
 * POST /api/calls
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const callerId = getUserId(req);

    const receiverId = req.body?.receiverId;

    if (typeof receiverId !== "string" || !receiverId.trim()) {
      return res.status(400).json({
        message: "Receiver ID is required",
      });
    }

    const normalizedReceiverId = receiverId.trim();

    if (normalizedReceiverId === callerId) {
      return res.status(400).json({
        message: "You cannot call yourself",
      });
    }

    const receiver = await prisma.user.findUnique({
      where: {
        id: normalizedReceiverId,
      },
      select: {
        id: true,
        displayName: true,
        lastSeenAt: true,
      },
    });

    if (!receiver) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    /*
     * PostgreSQL advisory transaction lock.
     *
     * Both directions of the same user pair produce
     * the same lock key, preventing concurrent calls
     * such as A -> B and B -> A from both creating
     * active calls.
     */
    const userIds = [callerId, normalizedReceiverId].sort();

    const lockKey = `${userIds[0]}:${userIds[1]}`;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${lockKey})
          )
        `;

      const activeCalls = await tx.call.findMany({
        where: {
          status: {
            in: ["RINGING", "ACCEPTED"],
          },
          OR: [
            {
              callerId,
              receiverId: normalizedReceiverId,
            },
            {
              callerId: normalizedReceiverId,
              receiverId: callerId,
            },
          ],
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          callerId: true,
          receiverId: true,
        },
      });

      const cutoff = new Date(Date.now() - RING_TIMEOUT_MS);

      const expiredCallIds = activeCalls
        .filter((call) => call.status === "RINGING" && call.createdAt <= cutoff)
        .map((call) => call.id);

      if (expiredCallIds.length > 0) {
        await tx.call.updateMany({
          where: {
            id: {
              in: expiredCallIds,
            },
            status: "RINGING",
          },
          data: {
            status: "MISSED",
            endedAt: new Date(),
          },
        });
      }

      const liveCall = activeCalls.find(
        (call) => !expiredCallIds.includes(call.id),
      );

      if (liveCall) {
        return {
          type: "active" as const,
          callId: liveCall.id,
        };
      }

      const call = await tx.call.create({
        data: {
          callerId,
          receiverId: normalizedReceiverId,
          status: "RINGING",
        },
        select: CALL_SELECT,
      });

      return {
        type: "created" as const,
        call,
        expiredCalls: activeCalls.filter((activeCall) =>
          expiredCallIds.includes(activeCall.id),
        ),
      };
    });

    if (result.type === "created" && result.expiredCalls.length > 0) {
      for (const expiredCall of result.expiredCalls) {
        emitToUser(expiredCall.callerId, "call-missed", {
          callId: expiredCall.id,
        });

        emitToUser(expiredCall.receiverId, "call-missed", {
          callId: expiredCall.id,
        });
      }
    }

    if (result.type === "active") {
      return res.status(409).json({
        message: "There is already an active call",
        callId: result.callId,
      });
    }

    emitToUser(normalizedReceiverId, "incoming-call", {
      callId: result.call.id,
      callerId: result.call.callerId,
      callerName: result.call.caller.displayName,
      status: result.call.status,
    });

    void sendIncomingCallPush(result.call.receiver.pushToken, {
      type: "incoming-call",
      callId: result.call.id,
      callerId: result.call.callerId,
      callerName: result.call.caller.displayName,
    });

    return res.status(201).json({
      message: "Call created",
      call: result.call,
    });
  } catch (error) {
    console.error(
      "Create call error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not create call",
    });
  }
});

/**
 * Get a call.
 *
 * GET /api/calls/:id
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const callId = getCallId(req);

    if (!callId) {
      return res.status(400).json({
        message: "Invalid call ID",
      });
    }

    await markCallMissedIfExpired(callId);

    const call = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: CALL_SELECT,
    });

    if (!call) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    if (call.callerId !== userId && call.receiverId !== userId) {
      return res.status(403).json({
        message: "You do not have access to this call",
      });
    }

    return res.status(200).json({
      call,
    });
  } catch (error) {
    console.error(
      "Get call error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not get call",
    });
  }
});

/**
 * Get authenticated user's call history.
 *
 * GET /api/calls
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const calls = await prisma.call.findMany({
      where: {
        OR: [
          {
            callerId: userId,
          },
          {
            receiverId: userId,
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
      select: CALL_SELECT,
    });

    return res.status(200).json({
      calls,
    });
  } catch (error) {
    console.error(
      "Get call history error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not get call history",
    });
  }
});

/**
 * Accept an incoming call.
 *
 * POST /api/calls/:id/accept
 */
router.post("/:id/accept", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const callId = getCallId(req);

    if (!callId) {
      return res.status(400).json({
        message: "Invalid call ID",
      });
    }

    await markCallMissedIfExpired(callId);

    const call = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: {
        id: true,
        callerId: true,
        receiverId: true,
        status: true,
      },
    });

    if (!call) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    if (call.receiverId !== userId) {
      return res.status(403).json({
        message: "Only the receiver can accept this call",
      });
    }

    if (call.status !== "RINGING") {
      return res.status(409).json({
        message: "This call is no longer ringing",
      });
    }

    const now = new Date();

    const result = await prisma.call.updateMany({
      where: {
        id: callId,
        receiverId: userId,
        status: "RINGING",
      },
      data: {
        status: "ACCEPTED",
        answeredAt: now,
        startedAt: now,
      },
    });

    if (result.count !== 1) {
      return res.status(409).json({
        message: "This call is no longer ringing",
      });
    }

    const updatedCall = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: CALL_SELECT,
    });

    if (!updatedCall) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    emitToUser(call.callerId, "call-accepted", {
      callId: call.id,
    });

    return res.status(200).json({
      message: "Call accepted",
      call: updatedCall,
    });
  } catch (error) {
    console.error(
      "Accept call error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not accept call",
    });
  }
});

/**
 * Reject an incoming call.
 *
 * POST /api/calls/:id/reject
 */
router.post("/:id/reject", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const callId = getCallId(req);

    if (!callId) {
      return res.status(400).json({
        message: "Invalid call ID",
      });
    }

    await markCallMissedIfExpired(callId);

    const call = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: {
        id: true,
        callerId: true,
        receiverId: true,
        status: true,
      },
    });

    if (!call) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    if (call.receiverId !== userId) {
      return res.status(403).json({
        message: "Only the receiver can reject this call",
      });
    }

    if (call.status !== "RINGING") {
      return res.status(409).json({
        message: "This call is no longer ringing",
      });
    }

    const result = await prisma.call.updateMany({
      where: {
        id: callId,
        receiverId: userId,
        status: "RINGING",
      },
      data: {
        status: "REJECTED",
        endedAt: new Date(),
      },
    });

    if (result.count !== 1) {
      return res.status(409).json({
        message: "This call is no longer ringing",
      });
    }

    const updatedCall = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: CALL_SELECT,
    });

    if (!updatedCall) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    emitToUser(call.callerId, "call-rejected", {
      callId: call.id,
    });

    return res.status(200).json({
      message: "Call rejected",
      call: updatedCall,
    });
  } catch (error) {
    console.error(
      "Reject call error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not reject call",
    });
  }
});

/**
 * End an active or ringing call.
 *
 * POST /api/calls/:id/end
 */
router.post("/:id/end", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const callId = getCallId(req);

    if (!callId) {
      return res.status(400).json({
        message: "Invalid call ID",
      });
    }

    await markCallMissedIfExpired(callId);

    const call = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: {
        id: true,
        callerId: true,
        receiverId: true,
        status: true,
      },
    });

    if (!call) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    if (call.callerId !== userId && call.receiverId !== userId) {
      return res.status(403).json({
        message: "You do not have access to this call",
      });
    }

    if (
      call.status === "ENDED" ||
      call.status === "REJECTED" ||
      call.status === "MISSED"
    ) {
      return res.status(409).json({
        message: "This call has already ended",
      });
    }

    const result = await prisma.call.updateMany({
      where: {
        id: callId,
        status: {
          in: ["RINGING", "ACCEPTED"],
        },
        OR: [
          {
            callerId: userId,
          },
          {
            receiverId: userId,
          },
        ],
      },
      data: {
        status: "ENDED",
        endedAt: new Date(),
      },
    });

    if (result.count !== 1) {
      return res.status(409).json({
        message: "This call has already ended",
      });
    }

    const updatedCall = await prisma.call.findUnique({
      where: {
        id: callId,
      },
      select: CALL_SELECT,
    });

    if (!updatedCall) {
      return res.status(404).json({
        message: "Call not found",
      });
    }

    const otherUserId =
      call.callerId === userId ? call.receiverId : call.callerId;

    emitToUser(otherUserId, "call-ended", {
      callId: call.id,
    });

    return res.status(200).json({
      message: "Call ended",
      call: updatedCall,
    });
  } catch (error) {
    console.error(
      "End call error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(500).json({
      message: "Could not end call",
    });
  }
});

export default router;
