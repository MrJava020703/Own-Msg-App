import type { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../types/index.js";

import { users } from "../services/user.service.js";
import { conversations } from "../services/conversation.service.js";
import { messages } from "../services/message.service.js";
import { prisma } from "../config/database.js";

type S = Socket<ClientToServerEvents, ServerToClientEvents>;

const ok = (ack: any, data: any) =>
  ack?.({
    success: true,
    data,
  });

const fail = (ack: any, error: unknown) =>
  ack?.({
    success: false,
    error: error instanceof Error ? error.message : "Request failed",
  });

export function socketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>
) {
  /**
   * userId -> socket IDs
   * This is used only for direct user notifications/presence.
   */
  const activeSockets = new Map<string, Set<string>>();

  /**
   * socketId -> userId
   */
  const socketOwners = new Map<string, string>();

  const emitToUser = (
    userId: string,
    event: string,
    payload: unknown
  ) => {
    const socketIds = activeSockets.get(userId);

    if (!socketIds) return;

    for (const socketId of socketIds) {
      io.to(socketId).emit(event as any, payload);
    }
  };

  const emitPresence = async (userId: string) => {
    const user = await users.public(userId);

    if (!user) return;

    io.emit("presence:updated", {
      userId,
      status: user.status,
      lastSeen: user.lastSeen,
    });
  };

  const registerSocket = async (userId: string, socketId: string) => {
    const existingOwner = socketOwners.get(socketId);

    if (existingOwner && existingOwner !== userId) {
      const oldSet = activeSockets.get(existingOwner);

      oldSet?.delete(socketId);

      if (!oldSet?.size) {
        activeSockets.delete(existingOwner);
      }
    }

    socketOwners.set(socketId, userId);

    let socketSet = activeSockets.get(userId);

    if (!socketSet) {
      socketSet = new Set<string>();
      activeSockets.set(userId, socketSet);
    }

    const firstConnection = socketSet.size === 0;

    socketSet.add(socketId);

    await users.attach(userId, socketId);

    return firstConnection;
  };

  io.on("connection", (socket: S) => {
    let userId: string | undefined;

    /**
     * LOGIN / RECONNECT
     */
    socket.on("user:join", async (payload, ack) => {
      try {
        const user = await users.public(payload.userId);

        if (!user) {
          throw new Error("Unknown user");
        }

        userId = user.id;

        const firstConnection = await registerSocket(
          user.id,
          socket.id
        );

        ok(ack, await users.public(user.id));

        if (firstConnection) {
          await emitPresence(user.id);
        }
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * CREATE / GET PRIVATE CONVERSATION
     */
    socket.on("conversation:create", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const conversation = await conversations.privateFor(
          userId,
          payload.receiverId
        );

        ok(ack, conversation);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * JOIN CONVERSATION ROOM
     *
     * Every client must join its conversation room.
     */
    socket.on("conversation:join", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        await conversations.assertMember(
          payload.conversationId,
          userId
        );

        await socket.join(`conversation:${payload.conversationId}`);

        ok(ack, true);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * SEND MESSAGE
     */
    socket.on("message:send", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const message = await messages.create(userId, payload);

        /**
         * ACK sender immediately.
         */
        ok(ack, message);

        /**
         * Sender's other tabs/devices.
         */
        emitToUser(userId, "message:sent", message);

        /**
         * Receiver's all connected tabs/devices.
         */
        emitToUser(
          payload.receiverId,
          "message:new",
          message
        );

        /**
         * Conversation room fallback.
         * Useful when both clients are already inside the room.
         */
        io.to(`conversation:${payload.conversationId}`).emit(
          "message:new",
          message
        );
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * DELIVERED
     */
    socket.on("message:delivered", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const message = await messages.deliver(
          payload.messageId,
          userId
        );

        emitToUser(message.senderId, "message:delivered", {
          messageId: message.id,
          userId,
          deliveredAt: new Date(),
        });

        ok(ack, true);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * READ
     */
    socket.on("message:read", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const readMessages = await messages.markRead(
          payload.conversationId,
          userId
        );

        for (const message of readMessages) {
          emitToUser(message.senderId, "message:read", {
            messageId: message.id,
            userId,
            readAt: new Date(),
          });
        }

        ok(ack, true);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * EDIT
     */
    socket.on("message:edit", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const message = await messages.edit(
          payload.messageId,
          userId,
          payload.content
        );

        emitToUser(message.senderId, "message:updated", message);
        emitToUser(message.receiverId, "message:updated", message);

        ok(ack, message);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * DELETE
     */
    socket.on("message:delete", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const message = await messages.remove(
          payload.messageId,
          userId
        );

        emitToUser(message.senderId, "message:deleted", message);
        emitToUser(message.receiverId, "message:deleted", message);

        ok(ack, message);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * REACTION
     */
    socket.on("message:react", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const message = await messages.react(
          payload.messageId,
          userId,
          payload.emoji
        );

        emitToUser(message.senderId, "message:reaction", message);
        emitToUser(message.receiverId, "message:reaction", message);

        ok(ack, message);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * TYPING START
     */
    socket.on("typing:start", async (payload) => {
      if (!userId) return;

      const user = await users.public(userId);

      if (!user) return;

      emitToUser(payload.receiverId, "typing:start", {
        conversationId: payload.conversationId,
        user,
      });
    });

    /**
     * TYPING STOP
     */
    socket.on("typing:stop", (payload) => {
      if (!userId) return;

      emitToUser(payload.receiverId, "typing:stop", {
        conversationId: payload.conversationId,
        userId,
      });
    });

    /**
     * CALL INITIATE
     */
    socket.on("call:initiate", async (payload, ack) => {
      try {
        if (!userId) {
          throw new Error("Join first");
        }

        const call = await prisma.call.create({
          data: {
            callerId: userId,
            receiverId: payload.receiverId,
            type: payload.type,
          },
        });

        const caller = await users.public(userId);

        if (caller) {
          emitToUser(payload.receiverId, "call:incoming", {
            call,
            caller,
          });
        }

        ok(ack, call);
      } catch (error) {
        fail(ack, error);
      }
    });

    /**
     * CALL STATUS
     */
    const callEvents = [
      ["call:accept", "ACCEPTED", "call:accepted"],
      ["call:reject", "REJECTED", "call:rejected"],
      ["call:end", "ENDED", "call:ended"],
    ] as const;

    for (const [event, status, notifyEvent] of callEvents) {
      socket.on(event as never, async (payload: any, ack: any) => {
        try {
          if (!userId) {
            throw new Error("Join first");
          }

          const call = await prisma.call.findUniqueOrThrow({
            where: {
              id: payload.callId,
            },
          });

          if (
            call.callerId !== userId &&
            call.receiverId !== userId
          ) {
            throw new Error("Call access denied");
          }

          const updatedCall = await prisma.call.update({
            where: {
              id: call.id,
            },
            data: {
              status,
              startedAt:
                status === "ACCEPTED"
                  ? new Date()
                  : call.startedAt,
              endedAt:
                status === "ENDED"
                  ? new Date()
                  : call.endedAt,
            },
          });

          emitToUser(
            updatedCall.callerId,
            notifyEvent,
            {
              call: updatedCall,
            }
          );

          emitToUser(
            updatedCall.receiverId,
            notifyEvent,
            {
              call: updatedCall,
            }
          );

          ok(ack, updatedCall);
        } catch (error) {
          fail(ack, error);
        }
      });
    }

    /**
     * WEBRTC SIGNALING
     */
    const webrtcEvents = [
      "webrtc:offer",
      "webrtc:answer",
      "webrtc:ice-candidate",
    ] as const;

    for (const event of webrtcEvents) {
      socket.on(event, (payload: any) => {
        if (!userId) return;

        emitToUser(payload.targetId, event, {
          ...payload,
          fromId: userId,
        });
      });
    }

    /**
     * DISCONNECT
     */
    socket.on("disconnect", async () => {
      const id =
        userId ??
        socketOwners.get(socket.id);

      socketOwners.delete(socket.id);

      if (!id) return;

      const socketSet = activeSockets.get(id);

      socketSet?.delete(socket.id);

      await users.detach(socket.id);

      if (!socketSet?.size) {
        activeSockets.delete(id);

        await emitPresence(id);
      }
    });
  });
}