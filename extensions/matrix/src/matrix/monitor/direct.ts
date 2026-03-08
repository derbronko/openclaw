import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
};

const DM_CACHE_TTL_MS = 30_000;

function isMatrixNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const error = err as { errcode?: string; statusCode?: number };
  return error.errcode === "M_NOT_FOUND" || error.statusCode === 404;
}

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  let lastDmUpdateMs = 0;
  let cachedSelfUserId: string | null = null;
  const memberCountCache = new Map<string, { count: number; ts: number }>();

  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId) {
      return cachedSelfUserId;
    }
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };

  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    try {
      await client.dms.update();
    } catch (err) {
      log(`matrix: dm cache refresh failed (${String(err)})`);
    }
  };

  const resolveMemberCount = async (roomId: string): Promise<number | null> => {
    const cached = memberCountCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.count;
    }
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      const count = members.length;
      memberCountCache.set(roomId, { count, ts: now });
      return count;
    } catch (err) {
      log(`matrix: dm member count failed room=${roomId} (${String(err)})`);
      return null;
    }
  };

  const hasDirectFlag = async (roomId: string, userId?: string): Promise<boolean> => {
    const target = userId?.trim();
    if (!target) {
      return false;
    }
    try {
      const state = await client.getRoomStateEvent(roomId, "m.room.member", target);
      return state?.is_direct === true;
    } catch {
      return false;
    }
  };

  const getDirectFlagState = async (
    roomId: string,
    userId?: string,
  ): Promise<"missing" | "true" | "false"> => {
    const target = userId?.trim();
    if (!target) {
      return "missing";
    }
    try {
      const state = await client.getRoomStateEvent(roomId, "m.room.member", target);
      if (state && "is_direct" in state) {
        return state.is_direct === true ? "true" : "false";
      }
      return "missing";
    } catch {
      return "missing";
    }
  };

  return {
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      await refreshDmCache();

      // Check m.direct account data (most authoritative)
      if (client.dms.isDm(roomId)) {
        log(`matrix: dm detected via m.direct room=${roomId}`);
        return true;
      }

      // Check m.room.member state for is_direct flag
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const directViaState =
        (await hasDirectFlag(roomId, senderId)) || (await hasDirectFlag(roomId, selfUserId ?? ""));
      if (directViaState) {
        log(`matrix: dm detected via member state room=${roomId}`);
        return true;
      }

      // Conservative fallback for broken DM flags
      // Only apply fallback when BOTH flags are truly missing (not explicitly false)
      const senderFlagState = await getDirectFlagState(roomId, senderId);
      const selfFlagState = await getDirectFlagState(roomId, selfUserId ?? "");

      const areFlagsMissing = senderFlagState === "missing" && selfFlagState === "missing";
      if (!areFlagsMissing) {
        log(`matrix: dm check room=${roomId} result=group (flags present)`);
        return false;
      }

      // Both flags are missing - apply conservative fallback
      // 2 members + no room name → likely a DM
      const memberCount = await resolveMemberCount(roomId);

      if (memberCount !== 2) {
        log(`matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
        return false;
      }

      // 2-member room: check if it has a room name
      try {
        const roomNameState = await client.getRoomStateEvent(roomId, "m.room.name", "");

        // If state event exists, check if it has a name field
        if ("name" in roomNameState) {
          const roomName = roomNameState.name;
          if (roomName && roomName.trim()) {
            // Has non-empty room name → group
            log(
              `matrix: dm check room=${roomId} result=group members=${memberCount} name="${roomName}"`,
            );
            return false;
          } else {
            // Empty or whitespace-only room name → treat as "no name" → DM
            log(
              `matrix: dm detected via fallback room=${roomId} members=${memberCount} name=empty`,
            );
            return true;
          }
        } else {
          // State event exists but has no name field → treat as group (explicit choice to have no name)
          log(`matrix: dm check room=${roomId} result=group members=${memberCount} name=undefined`);
          return false;
        }
      } catch (err) {
        if (isMatrixNotFoundError(err)) {
          // No room name state event → DM
          log(`matrix: dm detected via fallback room=${roomId} members=${memberCount} name=none`);
          return true;
        } else {
          // Network/auth error → conservative → group
          log(
            `matrix: dm check room=${roomId} result=group members=${memberCount} name=error (${String(err)})`,
          );
          return false;
        }
      }
    },
  };
}
