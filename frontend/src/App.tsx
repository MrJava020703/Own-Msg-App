import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./services/api";
import { socket } from "./services/socket";

import type {
  Conversation,
  Message,
  User,
} from "./types";

import { JoinScreen } from "./components/auth/JoinScreen";
import { Sidebar } from "./components/chat/Sidebar";
import { ChatPanel } from "./components/chat/ChatPanel";
import { CallOverlay } from "./components/call/CallOverlay";

const USER_KEY = "rtc-user";
const LAST_CHAT_KEY = "rtc-last-conversation";

type DeliveryState = "SENT" | "DELIVERED" | "READ";

function normalizeMessage(message: Message): Message {
  const read =
    Array.isArray(message.readReceipts) &&
    message.readReceipts.length > 0;

  return {
    ...message,
    delivery: read ? "READ" : "SENT",
  };
}

function mergeMessages(
  current: Message[],
  incoming: Message[]
): Message[] {
  const map = new Map<string, Message>();

  for (const message of current) {
    map.set(message.id, message);
  }

  for (const message of incoming) {
    map.set(message.id, message);
  }

  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(a.createdAt).getTime() -
      new Date(b.createdAt).getTime()
  );
}

export function App() {
  const [savedUser] = useState<User | null>(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);

      if (!raw) return null;

      return JSON.parse(raw) as User;
    } catch {
      return null;
    }
  });

  const [me, setMe] = useState<User | null>(savedUser);
  const [restoring, setRestoring] = useState(Boolean(savedUser));

  const [chats, setChats] = useState<Conversation[]>([]);
  const [active, setActive] =
    useState<Conversation | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] =
    useState<string | null>(null);

  const activeIdRef = useRef<string | undefined>(undefined);
  const meRef = useRef<User | null>(null);

  activeIdRef.current = active?.id;
  meRef.current = me;

  /**
   * Update a message without creating duplicates.
   */
  const updateMessage = useCallback(
    (message: Message) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
                ...item,
                ...message,
              }
            : item
        )
      );

      setChats((current) =>
        current.map((chat) =>
          chat.id === message.conversationId
            ? {
                ...chat,
                messages: [message],
              }
            : chat
        )
      );
    },
    []
  );

  /**
   * Load user's conversations.
   */
  const loadChats = useCallback(async (userId: string) => {
    const conversations =
      await api<Conversation[]>(
        `/conversations?userId=${encodeURIComponent(
          userId
        )}`
      );

    const valid = conversations.filter(
      (conversation) =>
        conversation &&
        typeof conversation.id === "string" &&
        Array.isArray(conversation.participants)
    );

    setChats(valid);

    return valid;
  }, []);

  /**
   * Open conversation.
   *
   * Important:
   * realtime messages are merged with history instead
   * of history blindly replacing current state.
   */
  const openConversation = useCallback(
    async (
      conversation: Conversation,
      userId: string
    ) => {
      if (!conversation?.id) return;

      activeIdRef.current = conversation.id;

      setActive(conversation);
      setTyping(null);

      localStorage.setItem(
        LAST_CHAT_KEY,
        conversation.id
      );

      /**
       * Join socket room first.
       */
      if (socket.connected) {
        socket.emit(
          "conversation:join",
          {
            conversationId: conversation.id,
          },
          () => {}
        );
      }

      try {
        const result = await api<{
          messages: Message[];
          nextCursor?: string | null;
        }>(
          `/conversations/${conversation.id}/messages?userId=${encodeURIComponent(
            userId
          )}`
        );

        const history = (result.messages ?? []).map(
          normalizeMessage
        );

        /**
         * Merge REST history with any realtime
         * messages that arrived while fetching.
         */
        setMessages((current) =>
          mergeMessages(current, history)
        );

        /**
         * Mark unread messages as read.
         */
        if (socket.connected) {
          socket.emit(
            "message:read",
            {
              conversationId: conversation.id,
            },
            () => {}
          );
        }
      } catch (error) {
        console.error(
          "Unable to load conversation",
          error
        );
      }
    },
    []
  );

  /**
   * Restore saved user + last conversation.
   */
  useEffect(() => {
    if (!savedUser) {
      setRestoring(false);
      return;
    }

    const savedUserId = savedUser.id;

    let cancelled = false;

    async function restore() {
      try {
        /**
         * Validate that the saved user still exists.
         */
        const user = await api<User>(
          `/users/${savedUserId}`
        );

        if (cancelled) return;

        setMe(user);
        meRef.current = user;

        const conversations =
          await loadChats(user.id);

        if (cancelled) return;

        const lastConversationId =
          localStorage.getItem(
            LAST_CHAT_KEY
          );

        if (lastConversationId) {
          const lastConversation =
            conversations.find(
              (conversation) =>
                conversation.id ===
                lastConversationId
            );

          if (lastConversation) {
            /**
             * Don't wait for socket connection here.
             * The socket connection effect below will
             * reconnect/rejoin automatically.
             */
            setActive(lastConversation);

            await openConversation(
              lastConversation,
              user.id
            );
          }
        }
      } catch (error) {
        console.error(
          "Unable to restore session",
          error
        );

        /**
         * Only clear invalid saved session.
         */
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(
          LAST_CHAT_KEY
        );

        if (!cancelled) {
          setMe(null);
        }
      } finally {
        if (!cancelled) {
          setRestoring(false);
        }
      }
    }

    void restore();

    return () => {
      cancelled = true;
    };
  }, [
    savedUser,
    loadChats,
    openConversation,
  ]);

  /**
   * Socket lifecycle.
   *
   * Critical fixes:
   * - listeners are registered BEFORE connect
   * - user:join happens after connect
   * - reconnect automatically rejoins user
   * - active conversation is rejoined
   */
  useEffect(() => {
    if (!me?.id) return;

    const userId = me.id;

    const joinSocket = () => {
      socket.emit(
        "user:join",
        {
          userId,
        },
        async (response: any) => {
          if (!response?.success) {
            console.error(
              "Socket user join failed",
              response?.error
            );
            return;
          }

          /**
           * Refresh user information after reconnect.
           */
          if (response.data) {
            setMe(response.data);
            meRef.current = response.data;

            localStorage.setItem(
              USER_KEY,
              JSON.stringify(response.data)
            );
          }

          /**
           * Rejoin currently open conversation.
           */
          const conversationId =
            activeIdRef.current;

          if (conversationId) {
            socket.emit(
              "conversation:join",
              {
                conversationId,
              },
              () => {}
            );
          }

          /**
           * Refresh conversations after reconnect.
           */
          try {
            await loadChats(userId);
          } catch (error) {
            console.error(
              "Unable to refresh chats",
              error
            );
          }
        }
      );
    };

    const onConnect = () => {
      console.log(
        "[socket] connected:",
        socket.id
      );

      joinSocket();
    };

    const onDisconnect = (reason: string) => {
      console.log(
        "[socket] disconnected:",
        reason
      );
    };

    /**
     * Presence updates.
     */
    const onPresence = (payload: any) => {
      if (!payload?.userId) return;

      setMe((current) => {
        if (
          !current ||
          current.id !== payload.userId
        ) {
          return current;
        }

        return {
          ...current,
          status:
            payload.status ?? current.status,
          lastSeen:
            payload.lastSeen ??
            current.lastSeen,
        };
      });

      setChats((current) =>
        current.map((conversation) => ({
          ...conversation,
          participants:
            conversation.participants.map(
              (participant) => {
                const user =
                  participant.user;

                if (
                  !user ||
                  user.id !== payload.userId
                ) {
                  return participant;
                }

                return {
                  ...participant,
                  user: {
                    ...user,
                    status:
                      payload.status ??
                      user.status,
                    lastSeen:
                      payload.lastSeen ??
                      user.lastSeen,
                  },
                };
              }
            ),
        }))
      );

      /**
       * Also update active conversation.
       */
      setActive((current) => {
        if (!current) return current;

        return {
          ...current,
          participants:
            current.participants.map(
              (participant) => {
                const user =
                  participant.user;

                if (
                  !user ||
                  user.id !== payload.userId
                ) {
                  return participant;
                }

                return {
                  ...participant,
                  user: {
                    ...user,
                    status:
                      payload.status ??
                      user.status,
                    lastSeen:
                      payload.lastSeen ??
                      user.lastSeen,
                  },
                };
              }
            ),
        };
      });
    };

    /**
     * New message.
     */
    const onNewMessage = (
      message: Message
    ) => {
      if (
        !message?.id ||
        !message.conversationId
      ) {
        return;
      }

      const normalized =
        normalizeMessage(message);

      /**
       * Always update conversation preview.
       */
      setChats((current) =>
        current.map((conversation) =>
          conversation.id ===
          message.conversationId
            ? {
                ...conversation,
                messages: [normalized],
              }
            : conversation
        )
      );

      /**
       * If this is current conversation,
       * merge instead of replacing.
       */
      if (
        message.conversationId ===
        activeIdRef.current
      ) {
        setMessages((current) =>
          mergeMessages(
            current,
            [normalized]
          )
        );

        /**
         * Receiver got the message.
         */
        if (
          message.receiverId === userId &&
          socket.connected
        ) {
          socket.emit(
            "message:delivered",
            {
              messageId: message.id,
            },
            () => {}
          );

          /**
           * Since conversation is open,
           * immediately mark it read too.
           */
          socket.emit(
            "message:read",
            {
              conversationId:
                message.conversationId,
            },
            () => {}
          );
        }
      } else if (
        message.receiverId === userId &&
        socket.connected
      ) {
        /**
         * Message received while another
         * conversation is open.
         */
        socket.emit(
          "message:delivered",
          {
            messageId: message.id,
          },
          () => {}
        );
      }
    };

    /**
     * Sender acknowledgement.
     */
    const onMessageSent = (
      message: Message
    ) => {
      if (!message?.id) return;

      const normalized =
        normalizeMessage(message);

      if (
        message.conversationId ===
        activeIdRef.current
      ) {
        setMessages((current) =>
          mergeMessages(
            current,
            [normalized]
          )
        );
      }

      setChats((current) =>
        current.map((conversation) =>
          conversation.id ===
          message.conversationId
            ? {
                ...conversation,
                messages: [normalized],
              }
            : conversation
        )
      );
    };

    /**
     * Delivered tick.
     */
    const onDelivered = (payload: any) => {
      if (!payload?.messageId) return;

      setMessages((current) =>
        current.map((message) =>
          message.id === payload.messageId
            ? {
                ...message,
                delivery:
                  "DELIVERED" as DeliveryState,
              }
            : message
        )
      );
    };

    /**
     * Read / seen tick.
     */
    const onRead = (payload: any) => {
      if (!payload?.messageId) return;

      setMessages((current) =>
        current.map((message) =>
          message.id === payload.messageId
            ? {
                ...message,
                delivery:
                  "READ" as DeliveryState,
              }
            : message
        )
      );
    };

    /**
     * Edited message.
     */
    const onUpdated = (
      message: Message
    ) => {
      if (!message?.id) return;

      updateMessage(message);
    };

    /**
     * Deleted message.
     */
    const onDeleted = (
      message: Message
    ) => {
      if (!message?.id) return;

      updateMessage(message);
    };

    /**
     * Reaction.
     */
    const onReaction = (
      message: Message
    ) => {
      if (!message?.id) return;

      updateMessage(message);
    };

    /**
     * Typing.
     */
    const onTypingStart = (payload: any) => {
      if (
        payload?.conversationId ===
          activeIdRef.current &&
        payload?.user?.displayName
      ) {
        setTyping(
          payload.user.displayName
        );
      }
    };

    const onTypingStop = (payload: any) => {
      if (
        payload?.conversationId ===
        activeIdRef.current
      ) {
        setTyping(null);
      }
    };

    /**
     * Register ALL listeners before connect.
     */
    socket.on("connect", onConnect);
    socket.on(
      "disconnect",
      onDisconnect
    );

    socket.on(
      "presence:updated",
      onPresence
    );

    socket.on(
      "message:new",
      onNewMessage
    );

    socket.on(
      "message:sent",
      onMessageSent
    );

    socket.on(
      "message:delivered",
      onDelivered
    );

    socket.on(
      "message:read",
      onRead
    );

    socket.on(
      "message:updated",
      onUpdated
    );

    socket.on(
      "message:deleted",
      onDeleted
    );

    socket.on(
      "message:reaction",
      onReaction
    );

    socket.on(
      "typing:start",
      onTypingStart
    );

    socket.on(
      "typing:stop",
      onTypingStop
    );

    /**
     * If socket is already connected,
     * manually join.
     */
    if (socket.connected) {
      joinSocket();
    } else {
      socket.connect();
    }

    return () => {
      socket.off(
        "connect",
        onConnect
      );

      socket.off(
        "disconnect",
        onDisconnect
      );

      socket.off(
        "presence:updated",
        onPresence
      );

      socket.off(
        "message:new",
        onNewMessage
      );

      socket.off(
        "message:sent",
        onMessageSent
      );

      socket.off(
        "message:delivered",
        onDelivered
      );

      socket.off(
        "message:read",
        onRead
      );

      socket.off(
        "message:updated",
        onUpdated
      );

      socket.off(
        "message:deleted",
        onDeleted
      );

      socket.off(
        "message:reaction",
        onReaction
      );

      socket.off(
        "typing:start",
        onTypingStart
      );

      socket.off(
        "typing:stop",
        onTypingStop
      );

      socket.disconnect();
    };
  }, [me?.id, loadChats, updateMessage]);

  /**
   * Login / first-time user creation.
   */
  async function join(displayName: string) {
    try {
      const user = await api<User>(
        "/users",
        {
          method: "POST",
          body: JSON.stringify({
            displayName,
          }),
        }
      );

      localStorage.setItem(
        USER_KEY,
        JSON.stringify(user)
      );

      setMe(user);
      meRef.current = user;

      await loadChats(user.id);
    } catch (error) {
      console.error(
        "Unable to login",
        error
      );
    }
  }

  /**
   * Search result / new chat.
   */
  async function selectUser(user: User) {
    if (!me?.id || !user?.id) return;

    if (user.id === me.id) return;

    try {
      const conversation =
        await new Promise<Conversation>(
          (resolve, reject) => {
            if (!socket.connected) {
              reject(
                new Error(
                  "Socket is not connected"
                )
              );
              return;
            }

            socket.emit(
              "conversation:create",
              {
                receiverId: user.id,
              },
              (response: any) => {
                if (
                  response?.success
                ) {
                  resolve(
                    response.data
                  );
                } else {
                  reject(
                    new Error(
                      response?.error ??
                        "Unable to create conversation"
                    )
                  );
                }
              }
            );
          }
        );

      setChats((current) => {
        if (
          current.some(
            (item) =>
              item.id ===
              conversation.id
          )
        ) {
          return current;
        }

        return [
          {
            ...conversation,
            messages:
              conversation.messages ??
              [],
          },
          ...current,
        ];
      });

      await openConversation(
        conversation,
        me.id
      );
    } catch (error) {
      console.error(
        "Unable to open chat",
        error
      );
    }
  }

  /**
   * Logout completely.
   */
  function logout() {
    socket.disconnect();

    localStorage.removeItem(
      USER_KEY
    );

    localStorage.removeItem(
      LAST_CHAT_KEY
    );

    setMe(null);
    meRef.current = null;

    setChats([]);
    setActive(null);
    activeIdRef.current = undefined;

    setMessages([]);
    setTyping(null);
  }

  if (restoring) {
    return (
      <div className="app-loading">
        Restoring your chat...
      </div>
    );
  }

  if (!me) {
    return (
      <JoinScreen
        onJoin={join}
      />
    );
  }

  return (
    <main className="app-shell">
      <Sidebar
        me={me}
        chats={chats}
        activeId={active?.id ?? null}
        onSelect={selectUser}
        onLogout={logout}
      />

      <ChatPanel
        me={me}
        conversation={active}
        messages={messages}
        typing={typing}
        onMessage={(message) => {
          setMessages((current) =>
            mergeMessages(
              current,
              [normalizeMessage(message)]
            )
          );
        }}
      />

      <CallOverlay
        me={me}
      />
    </main>
  );
}