import { prisma } from "../config/database.js";
import { conversations } from "./conversation.service.js";

const include = {
  sender: {
    select: {
      id: true,
      displayName: true,
      avatar: true,
      status: true,
      lastSeen: true,
    },
  },
  receiver: {
    select: {
      id: true,
      displayName: true,
      avatar: true,
      status: true,
      lastSeen: true,
    },
  },
  attachments: true,
  reactions: true,
  readReceipts: true,
} as const;

export const messages = {
  async create(
    senderId: string,
    p: {
      conversationId: string;
      receiverId: string;
      type?:
        | "TEXT"
        | "EMOJI"
        | "STICKER"
        | "GIF"
        | "IMAGE"
        | "FILE";
      content: string;
      replyToId?: string;
      attachments?: {
        url: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
      }[];
    }
  ) {
    await conversations.assertMember(
      p.conversationId,
      senderId
    );

    await conversations.assertMember(
      p.conversationId,
      p.receiverId
    );

    return prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: p.conversationId,
          senderId,
          receiverId: p.receiverId,
          type: p.type ?? "TEXT",
          content: p.content,
          replyToId: p.replyToId,
          attachments: {
            create: p.attachments ?? [],
          },
        },
        include,
      });

      await tx.conversation.update({
        where: {
          id: p.conversationId,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      return message;
    });
  },

  async page(
    conversationId: string,
    userId: string,
    cursor?: string,
    limit = 30
  ) {
    await conversations.assertMember(
      conversationId,
      userId
    );

    const rows =
      await prisma.message.findMany({
        where: {
          conversationId,
        },
        include,
        orderBy: {
          createdAt: "desc",
        },
        take: limit + 1,
        ...(cursor
          ? {
              cursor: {
                id: cursor,
              },
              skip: 1,
            }
          : {}),
      });

    const hasMore = rows.length > limit;

    if (hasMore) {
      rows.pop();
    }

    return {
      messages: rows,
      nextCursor: hasMore
        ? rows[rows.length - 1]?.id ?? null
        : null,
    };
  },

  async edit(
    id: string,
    userId: string,
    content: string
  ) {
    const message =
      await prisma.message.findUniqueOrThrow({
        where: {
          id,
        },
      });

    if (message.senderId !== userId) {
      throw new Error(
        "Only the sender can edit this message"
      );
    }

    if (message.deletedAt) {
      throw new Error(
        "Deleted message cannot be edited"
      );
    }

    return prisma.message.update({
      where: {
        id,
      },
      data: {
        content: content.trim(),
        editedAt: new Date(),
      },
      include,
    });
  },

  async remove(
    id: string,
    userId: string
  ) {
    const message =
      await prisma.message.findUniqueOrThrow({
        where: {
          id,
        },
      });

    if (
      message.senderId !== userId &&
      message.receiverId !== userId
    ) {
      throw new Error(
        "Message delete denied"
      );
    }

    return prisma.message.update({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
        content: "",
      },
      include,
    });
  },

  async deliver(
    id: string,
    userId: string
  ) {
    const message =
      await prisma.message.findUniqueOrThrow({
        where: {
          id,
        },
      });

    if (message.receiverId !== userId) {
      throw new Error(
        "Message delivery denied"
      );
    }

    /*
     * The current Prisma schema does not have
     * a separate delivery-receipt table/field.
     *
     * Delivery is therefore acknowledged in realtime
     * through Socket.IO.
     */
    return message;
  },

  async react(
    id: string,
    userId: string,
    emoji: string
  ) {
    const supported = [
      "❤️",
      "😂",
      "👍",
      "🔥",
      "😮",
      "😢",
    ];

    if (!supported.includes(emoji)) {
      throw new Error(
        "Unsupported reaction"
      );
    }

    const message =
      await prisma.message.findUniqueOrThrow({
        where: {
          id,
        },
      });

    await conversations.assertMember(
      message.conversationId,
      userId
    );

    const key = {
      messageId_userId_emoji: {
        messageId: id,
        userId,
        emoji,
      },
    };

    const existing =
      await prisma.messageReaction.findUnique({
        where: key,
      });

    if (existing) {
      await prisma.messageReaction.delete({
        where: {
          id: existing.id,
        },
      });
    } else {
      await prisma.messageReaction.create({
        data: {
          messageId: id,
          userId,
          emoji,
        },
      });
    }

    return prisma.message.findUniqueOrThrow({
      where: {
        id,
      },
      include,
    });
  },

  async markRead(
    conversationId: string,
    userId: string
  ) {
    await conversations.assertMember(
      conversationId,
      userId
    );

    const unread =
      await prisma.message.findMany({
        where: {
          conversationId,
          receiverId: userId,
          deletedAt: null,
        },
        select: {
          id: true,
          senderId: true,
        },
      });

    if (unread.length === 0) {
      return [];
    }

    const now = new Date();

    await prisma.$transaction(
      unread.map((message) =>
        prisma.messageRead.upsert({
          where: {
            messageId_userId: {
              messageId: message.id,
              userId,
            },
          },
          create: {
            messageId: message.id,
            userId,
            readAt: now,
          },
          update: {
            readAt: now,
          },
        })
      )
    );

    return unread;
  },
};