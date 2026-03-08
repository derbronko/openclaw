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
      // Try to get room name state first to determine if fallback applies
      try {
        const roomNameState = await client.getRoomStateEvent(roomId, "m.room.name", "");

        if ("name" in roomNameState) {
          // Room has explicit name configuration - apply optimized fallback logic
          // Check member count first for efficiency
          const memberCount = await resolveMemberCount(roomId);

          if (memberCount !== 2) {
            log(`matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
            return false;
          }

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
          // Room name state exists but has no name field → old behavior (no fallback)
          log(`matrix: dm check room=${roomId} result=group (no explicit name field)`);
          return false;
        }
      } catch (err) {
        // Room name state access failed - apply fallback with member count check
        const memberCount = await resolveMemberCount(roomId);

        if (memberCount !== 2) {
          log(
            `matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"} name=${isMatrixNotFoundError(err) ? "missing" : "error"}`,
          );
          return false;
        }

        if (isMatrixNotFoundError(err)) {
          // Room name state missing - apply fallback: 2 members + no name → DM
          log(
            `matrix: dm detected via fallback room=${roomId} members=${memberCount} name=missing`,
          );
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
