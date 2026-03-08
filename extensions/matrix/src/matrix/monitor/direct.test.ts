import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createDirectRoomTracker } from "./direct.js";

function createMockClient(params: {
  isDm?: boolean;
  senderDirect?: boolean;
  selfDirect?: boolean;
  members?: string[];
  roomNameState?: { exists: boolean; name?: string } | { error: "M_NOT_FOUND" | "NETWORK_ERROR" };
}) {
  const members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  return {
    dms: {
      update: vi.fn().mockResolvedValue(undefined),
      isDm: vi.fn().mockReturnValue(params.isDm === true),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getJoinedRoomMembers: vi.fn().mockResolvedValue(members),
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (_roomId: string, event: string, stateKey: string) => {
        // Handle m.room.name state event (for fallback logic)
        if (event === "m.room.name" && stateKey === "") {
          const roomNameConfig = params.roomNameState;
          if (roomNameConfig) {
            if ("error" in roomNameConfig) {
              if (roomNameConfig.error === "M_NOT_FOUND") {
                const err = new Error("M_NOT_FOUND") as Error & {
                  errcode?: string;
                  statusCode?: number;
                };
                err.errcode = "M_NOT_FOUND";
                err.statusCode = 404;
                throw err;
              } else if (roomNameConfig.error === "NETWORK_ERROR") {
                throw new Error("Network error");
              }
            } else if ("exists" in roomNameConfig) {
              if (!roomNameConfig.exists) {
                const err = new Error("M_NOT_FOUND") as Error & {
                  errcode?: string;
                  statusCode?: number;
                };
                err.errcode = "M_NOT_FOUND";
                err.statusCode = 404;
                throw err;
              }
              return { name: roomNameConfig.name ?? "Room Name" };
            }
          }
        }

        // Handle m.room.member state event (for is_direct flag)
        if (event === "m.room.member") {
          if (stateKey === "@alice:example.org") {
            return { is_direct: params.senderDirect === true };
          }
          if (stateKey === "@bot:example.org") {
            return { is_direct: params.selfDirect === true };
          }
        }

        return {};
      }),
  } as unknown as MatrixClient;
}

describe("createDirectRoomTracker", () => {
  it("treats m.direct rooms as DMs", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ isDm: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("does not classify 2-member rooms as DMs without direct flags", async () => {
    const client = createMockClient({ isDm: false });
    const tracker = createDirectRoomTracker(client);
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("uses is_direct member flags when present", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ senderDirect: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  // ========================================
  // Fallback Tests (Red Phase - it.skip)
  // ========================================

  describe("Conservative fallback for broken DM flags", () => {
    it("classifies 2-member room with no room name (M_NOT_FOUND) as DM", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { error: "M_NOT_FOUND" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      // Should fetch member count
      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      // Should attempt to fetch room name
      expect(client.getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.name", "");
    });

    it("classifies 2-member room with non-empty room name as group", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { exists: true, name: "Project Discussion" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(false);

      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      expect(client.getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.name", "");
    });

    it("classifies 2-member room with whitespace-only room name as DM", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { exists: true, name: "   \n  " },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      expect(client.getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.name", "");
    });

    it("conservatively classifies 2-member room as group on network error", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { error: "NETWORK_ERROR" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(false);

      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      expect(client.getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.name", "");
    });

    it.skip("classifies 3-member room as group regardless of room name", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bob:example.org", "@bot:example.org"],
        roomNameState: { error: "M_NOT_FOUND" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(false);

      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      // Should NOT attempt to fetch room name for 3+ member rooms
      expect(client.getRoomStateEvent).not.toHaveBeenCalledWith(
        "!room:example.org",
        "m.room.name",
        "",
      );
    });
  });

  // ========================================
  // Priority Tests (Red Phase - it.skip)
  // ========================================

  describe("Priority ordering", () => {
    it("m.direct wins over is_direct flag", async () => {
      const client = createMockClient({
        isDm: true,
        senderDirect: false, // conflicting signal
        members: ["@alice:example.org", "@bot:example.org"],
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      // Should NOT fetch member count or room name (early return)
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
      expect(client.getRoomStateEvent).not.toHaveBeenCalledWith(
        "!room:example.org",
        "m.room.name",
        "",
      );
    });

    it("m.direct wins over fallback logic", async () => {
      const client = createMockClient({
        isDm: true,
        senderDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { error: "M_NOT_FOUND" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      // Should NOT fetch member count or room name (early return)
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
      expect(client.getRoomStateEvent).not.toHaveBeenCalledWith(
        "!room:example.org",
        "m.room.name",
        "",
      );
    });

    it("is_direct flag wins over fallback logic", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: true,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { exists: true, name: "Named Room" }, // fallback would say group
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      // Should NOT fetch member count or room name (early return after is_direct check)
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
      expect(client.getRoomStateEvent).not.toHaveBeenCalledWith(
        "!room:example.org",
        "m.room.name",
        "",
      );
    });

    it("fallback only runs when both m.direct and is_direct are false", async () => {
      const client = createMockClient({
        isDm: false,
        senderDirect: false,
        selfDirect: false,
        members: ["@alice:example.org", "@bot:example.org"],
        roomNameState: { error: "M_NOT_FOUND" },
      });
      const tracker = createDirectRoomTracker(client);

      await expect(
        tracker.isDirectMessage({
          roomId: "!room:example.org",
          senderId: "@alice:example.org",
          selfUserId: "@bot:example.org",
        }),
      ).resolves.toBe(true);

      // Should fetch member count and room name for fallback
      expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
      expect(client.getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.name", "");
    });
  });
});
