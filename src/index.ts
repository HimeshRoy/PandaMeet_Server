import "dotenv/config";

import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import http from "http";
import { Server } from "socket.io";

import { prisma } from "./lib/prisma";
import { authenticateSocket } from "./lib/socketAuth";

import authRouter from "./routes/auth";
import callsRouter, { setCallSocketServer } from "./routes/calls";
import usersRouter from "./routes/users";

const app = express();

const NODE_ENV = process.env.NODE_ENV?.trim() || "development";

function getPort(): number {
  const rawPort = process.env.PORT?.trim() || "5000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT configuration");
  }

  return port;
}

const PORT = getPort();

/*
 * CLIENT_URL is kept for compatibility with the existing
 * server configuration.
 *
 * Native React Native requests normally do not send a browser
 * Origin header, so mobile API requests are not dependent on
 * this value.
 *
 * If browser-based access is ever enabled again, configure
 * CLIENT_URL as a comma-separated allowlist.
 */
const configuredOrigins = (process.env.CLIENT_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOrigin: CorsOptions["origin"] = (origin, callback) => {
  /*
   * Native mobile clients generally have no Origin header.
   */
  if (!origin) {
    callback(null, true);
    return;
  }

  if (configuredOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error("Origin not allowed"));
};

const httpCorsOptions: CorsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
};

app.disable("x-powered-by");

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(cors(httpCorsOptions));

/*
 * Request bodies are deliberately kept small.
 *
 * Authentication accepts Google ID tokens up to 10 KB,
 * while normal API requests are much smaller.
 */
app.use(
  express.json({
    limit: "32kb",
  }),
);

app.use(cookieParser());

/*
 * Health endpoint.
 *
 * This confirms that the HTTP server is alive.
 * It intentionally does not expose database details.
 */
app.get("/health", (_req, res) => {
  return res.status(200).json({
    status: "ok",
  });
});

app.get("/", (_req, res) => {
  return res.status(200).send("PandaMeet signaling server is running!");
});

/*
 * API routes.
 */
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/calls", callsRouter);

/*
 * Unknown API/page route.
 */
app.use((_req, res) => {
  return res.status(404).json({
    message: "Not found",
  });
});

/*
 * Final Express error handler.
 *
 * Never expose internal error details to clients.
 */
app.use(
  (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    return res.status(500).json({
      message: "Internal server error",
    });
  },
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST"],
  },

  /*
   * WebRTC SDP and ICE messages are small.
   * Keeping this limit bounded prevents oversized
   * Socket.IO payloads from consuming unnecessary memory.
   */
  maxHttpBufferSize: 256 * 1024,

  pingInterval: 25_000,
  pingTimeout: 20_000,
});

/*
 * calls.ts uses this Socket.IO instance to emit
 * call lifecycle events to authenticated users.
 */
setCallSocketServer(io);

/*
 * Validate a Socket.IO room identifier.
 *
 * Rooms used by the call system have this format:
 *
 * call:<callId>
 */
function getCallIdFromRoom(roomId: unknown): string | null {
  if (typeof roomId !== "string" || !roomId.startsWith("call:")) {
    return null;
  }

  const callId = roomId.substring("call:".length).trim();

  /*
   * Prisma cuid IDs are alphanumeric. The slightly
   * broader character set also keeps this safe if the
   * ID strategy changes later.
   */
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
    return null;
  }

  return callId;
}

/*
 * Validate a room identifier before using it with Socket.IO.
 */
function isValidRoomId(roomId: unknown): roomId is string {
  return getCallIdFromRoom(roomId) !== null;
}

/*
 * Validate SDP offer/answer payloads.
 */
type SessionDescriptionPayload = {
  type: "offer" | "answer";
  sdp: string;
};

function isSessionDescriptionPayload(
  value: unknown,
): value is SessionDescriptionPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if (payload.type !== "offer" && payload.type !== "answer") {
    return false;
  }

  if (
    typeof payload.sdp !== "string" ||
    !payload.sdp.trim() ||
    payload.sdp.length > 100_000
  ) {
    return false;
  }

  return true;
}

/*
 * Validate ICE candidate payloads.
 */
type IceCandidatePayload = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

function isIceCandidatePayload(value: unknown): value is IceCandidatePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if (
    typeof payload.candidate !== "string" ||
    !payload.candidate.trim() ||
    payload.candidate.length > 8_192
  ) {
    return false;
  }

  if (
    payload.sdpMid !== undefined &&
    payload.sdpMid !== null &&
    (typeof payload.sdpMid !== "string" || payload.sdpMid.length > 256)
  ) {
    return false;
  }

  if (
    payload.sdpMLineIndex !== undefined &&
    payload.sdpMLineIndex !== null &&
    (typeof payload.sdpMLineIndex !== "number" ||
      !Number.isInteger(payload.sdpMLineIndex) ||
      payload.sdpMLineIndex < 0 ||
      payload.sdpMLineIndex > 128)
  ) {
    return false;
  }

  return true;
}

/*
 * Limit signaling traffic per socket.
 *
 * WebRTC can legitimately produce multiple ICE candidates,
 * so this limit is deliberately generous.
 */
const SIGNALING_WINDOW_MS = 10_000;
const SIGNALING_MAX_EVENTS = 250;

function createSignalingRateLimiter(): () => boolean {
  let windowStartedAt = Date.now();
  let eventCount = 0;

  return () => {
    const now = Date.now();

    if (now - windowStartedAt >= SIGNALING_WINDOW_MS) {
      windowStartedAt = now;
      eventCount = 0;
    }

    eventCount += 1;

    return eventCount <= SIGNALING_MAX_EVENTS;
  };
}

/*
 * Authenticate every Socket.IO connection using
 * the same server-side session system as HTTP APIs.
 */
io.use(async (socket, next) => {
  try {
    const sessionToken = socket.handshake.auth?.sessionToken;

    if (
      typeof sessionToken !== "string" ||
      !sessionToken.trim() ||
      sessionToken.length > 512
    ) {
      return next(new Error("Authentication required"));
    }

    const user = await authenticateSocket(sessionToken);

    if (!user) {
      return next(new Error("Invalid session"));
    }

    /*
     * Store only the authenticated user object.
     *
     * The session token is deliberately not stored
     * on socket.data.
     */
    socket.data.user = user;

    return next();
  } catch {
    return next(new Error("Socket authentication failed"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user;

  /*
   * Every authenticated device joins its own private
   * user room.
   *
   * calls.ts uses these rooms for incoming-call,
   * accepted, rejected, missed and ended events.
   */
  socket.join(`user:${user.id}`);

  const allowSignaling = createSignalingRateLimiter();

  /*
   * Verify that the authenticated user is one of
   * the participants in the call represented by
   * the requested room.
   */
  const verifyCallAccess = async (roomId: unknown) => {
    const callId = getCallIdFromRoom(roomId);

    if (!callId) {
      return null;
    }

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
      return null;
    }

    if (call.callerId !== user.id && call.receiverId !== user.id) {
      return null;
    }

    return call;
  };

  /*
   * JOIN ROOM
   */
  socket.on("join-room", async (roomId: unknown) => {
    try {
      if (!allowSignaling()) {
        socket.emit("room-error", {
          message: "Too many signaling requests.",
        });

        return;
      }

      if (!isValidRoomId(roomId)) {
        socket.emit("room-error", {
          message: "Invalid call room.",
        });

        return;
      }

      const call = await verifyCallAccess(roomId);

      if (!call) {
        socket.emit("room-error", {
          message: "You do not have access to this call.",
        });

        return;
      }

      if (call.status !== "RINGING" && call.status !== "ACCEPTED") {
        socket.emit("room-error", {
          message: "This call is no longer active.",
        });

        return;
      }

      socket.join(roomId);

      const room = io.sockets.adapter.rooms.get(roomId);

      const userCount = room ? room.size : 0;

      socket.emit("room-info", {
        roomId,
        userCount,
      });

      socket.to(roomId).emit("user-joined");
    } catch {
      socket.emit("room-error", {
        message: "Could not join the call.",
      });
    }
  });

  /*
   * OFFER
   */
  socket.on("offer", async (payload: unknown) => {
    try {
      if (!allowSignaling()) {
        return;
      }

      if (typeof payload !== "object" || payload === null) {
        return;
      }

      const data = payload as Record<string, unknown>;

      const roomId = data.roomId;
      const offer = data.offer;

      if (
        !isValidRoomId(roomId) ||
        !isSessionDescriptionPayload(offer) ||
        offer.type !== "offer"
      ) {
        return;
      }

      const call = await verifyCallAccess(roomId);

      if (!call || call.status !== "ACCEPTED") {
        return;
      }

      if (!socket.rooms.has(roomId)) {
        return;
      }

      socket.to(roomId).emit("offer", {
        offer,
      });
    } catch {
      /*
       * Invalid signaling messages are ignored.
       */
    }
  });

  /*
   * ANSWER
   */
  socket.on("answer", async (payload: unknown) => {
    try {
      if (!allowSignaling()) {
        return;
      }

      if (typeof payload !== "object" || payload === null) {
        return;
      }

      const data = payload as Record<string, unknown>;

      const roomId = data.roomId;
      const answer = data.answer;

      if (
        !isValidRoomId(roomId) ||
        !isSessionDescriptionPayload(answer) ||
        answer.type !== "answer"
      ) {
        return;
      }

      const call = await verifyCallAccess(roomId);

      if (!call || call.status !== "ACCEPTED") {
        return;
      }

      if (!socket.rooms.has(roomId)) {
        return;
      }

      socket.to(roomId).emit("answer", {
        answer,
      });
    } catch {
      /*
       * Invalid signaling messages are ignored.
       */
    }
  });

  /*
   * ICE CANDIDATE
   */
  socket.on("ice-candidate", async (payload: unknown) => {
    try {
      if (!allowSignaling()) {
        return;
      }

      if (typeof payload !== "object" || payload === null) {
        return;
      }

      const data = payload as Record<string, unknown>;

      const roomId = data.roomId;
      const candidate = data.candidate;

      if (!isValidRoomId(roomId) || !isIceCandidatePayload(candidate)) {
        return;
      }

      const call = await verifyCallAccess(roomId);

      if (!call || call.status !== "ACCEPTED") {
        return;
      }

      if (!socket.rooms.has(roomId)) {
        return;
      }

      socket.to(roomId).emit("ice-candidate", {
        candidate,
      });
    } catch {
      /*
       * Invalid signaling messages are ignored.
       */
    }
  });

  /*
   * LEAVE ROOM
   */
  socket.on("leave-room", async (roomId: unknown) => {
    try {
      if (!allowSignaling()) {
        return;
      }

      if (!isValidRoomId(roomId)) {
        return;
      }

      const call = await verifyCallAccess(roomId);

      if (!call) {
        return;
      }

      if (!socket.rooms.has(roomId)) {
        return;
      }

      socket.to(roomId).emit("user-left");

      socket.leave(roomId);
    } catch {
      /*
       * Invalid leave requests are ignored.
       */
    }
  });

  socket.on("disconnect", () => {
    /*
     * Socket.IO automatically removes the socket
     * from its rooms on disconnect.
     *
     * No session token, socket ID, room ID,
     * phone number or other sensitive value
     * is logged here.
     */
  });
});

/*
 * Graceful shutdown.
 *
 * Stop accepting new HTTP connections, close Socket.IO,
 * then close the Prisma connection.
 */
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  try {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  } catch {
    /*
     * Continue shutdown even if the HTTP server
     * was already closed.
     */
  }

  try {
    await new Promise<void>((resolve) => {
      io.close(() => {
        resolve();
      });
    });
  } catch {
    /*
     * Continue shutdown.
     */
  }

  try {
    await prisma.$disconnect();
  } catch {
    /*
     * Nothing else to do during shutdown.
     */
  }
}

process.once("SIGINT", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

/*
 * Start only after the database connection succeeds.
 */
async function startServer(): Promise<void> {
  try {
    await prisma.$connect();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`PandaMeet signaling server running on port ${PORT}`);
    });
  } catch {
    console.error("PandaMeet server startup failed");

    await prisma.$disconnect();

    process.exit(1);
  }
}

void startServer();
