const PUSH_TTL_SECONDS = 35;

type ExpoPushMessage = {
  to: string;
  sound: "default";
  title: string;
  body: string;
  priority: "high";
  channelId: string;
  ttl: number;
  data: IncomingCallPushData;
};

type ExpoPushTicket =
  | {
      status: "ok";
      id: string;
    }
  | {
      status: "error";
      message?: string;
      details?: {
        error?: string;
      };
    };

export type IncomingCallPushData = {
  type: "incoming-call";
  callId: string;
  callerId: string;
  callerName: string;
};

function isValidExpoPushToken(token: string): boolean {
  return /^ExponentPushToken\[[^\]]+\]$/.test(token);
}

export async function sendIncomingCallPush(
  pushToken: string | null | undefined,
  data: IncomingCallPushData,
): Promise<boolean> {
  if (!pushToken || !isValidExpoPushToken(pushToken)) {
    return false;
  }

  try {
    const { Expo } = await import("expo-server-sdk");
    const expo = new Expo();

    const message: ExpoPushMessage = {
      to: pushToken,
      sound: "default",
      title: "Incoming video call",
      body: `${data.callerName} is calling you`,
      priority: "high",
      channelId: "incoming-calls",
      ttl: PUSH_TTL_SECONDS,
      data,
    };

    const chunks = expo.chunkPushNotifications([message]);

    for (const chunk of chunks) {
      const tickets = (await expo.sendPushNotificationsAsync(
        chunk,
      )) as ExpoPushTicket[];

      for (const ticket of tickets) {
        if (ticket.status === "error") {
          console.warn(
            "PandaMeet push notification failed:",
            ticket.message ?? "Unknown push error",
          );
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    console.warn(
      "PandaMeet push notification request failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return false;
  }
}
