import { describe, expect, it } from "vitest";
import { resolveMatrixRoomConfig } from "./rooms.js";

describe("resolveMatrixRoomConfig", () => {
  it("matches room IDs and aliases, not names", () => {
    const rooms = {
      "!room:example.org": { allow: true },
      "#alias:example.org": { allow: true },
      "Project Room": { allow: true },
    };

    const byId = resolveMatrixRoomConfig({
      rooms,
      roomId: "!room:example.org",
      aliases: [],
      name: "Project Room",
    });
    expect(byId.allowed).toBe(true);
    expect(byId.matchKey).toBe("!room:example.org");

    const byAlias = resolveMatrixRoomConfig({
      rooms,
      roomId: "!other:example.org",
      aliases: ["#alias:example.org"],
      name: "Other Room",
    });
    expect(byAlias.allowed).toBe(true);
    expect(byAlias.matchKey).toBe("#alias:example.org");

    const byName = resolveMatrixRoomConfig({
      rooms: { "Project Room": { allow: true } },
      roomId: "!different:example.org",
      aliases: [],
      name: "Project Room",
    });
    expect(byName.allowed).toBe(false);
    expect(byName.config).toBeUndefined();
  });

  // ========================================
  // matchSource Classification Tests
  // ========================================

  describe("matchSource classification", () => {
    it("sets matchSource to 'direct' for direct room ID match", () => {
      const rooms = {
        "!room:example.org": { allow: true },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("direct");
      expect(result.matchKey).toBe("!room:example.org");
      expect(result.allowed).toBe(true);
    });

    it("sets matchSource to 'direct' for direct alias match", () => {
      const rooms = {
        "#project:example.org": { allow: true },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: ["#project:example.org"],
      });

      expect(result.matchSource).toBe("direct");
      expect(result.matchKey).toBe("#project:example.org");
      expect(result.allowed).toBe(true);
    });

    it("sets matchSource to 'wildcard' for wildcard match", () => {
      const rooms = {
        "*": { allow: true },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("wildcard");
      expect(result.matchKey).toBe("*");
      expect(result.allowed).toBe(true);
    });

    it("sets matchSource to undefined when no match", () => {
      const rooms = {
        "!other:example.org": { allow: true },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBeUndefined();
      expect(result.matchKey).toBeUndefined();
      expect(result.config).toBeUndefined();
      expect(result.allowed).toBe(false);
    });

    it("prefers direct match over wildcard", () => {
      const rooms = {
        "!room:example.org": { allow: true, skills: ["direct-skill"] },
        "*": { allow: true, skills: ["wildcard-skill"] },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("direct");
      expect(result.matchKey).toBe("!room:example.org");
      expect(result.config?.skills).toEqual(["direct-skill"]);
    });

    it("falls back to wildcard when no direct match", () => {
      const rooms = {
        "!other:example.org": { allow: false },
        "*": { allow: true, skills: ["wildcard-skill"] },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("wildcard");
      expect(result.matchKey).toBe("*");
      expect(result.config?.skills).toEqual(["wildcard-skill"]);
    });
  });

  // ========================================
  // Config Override Tests (Behavioral)
  // ========================================

  describe("Config override behavior", () => {
    it("indicates direct match for explicitly configured room (enables override)", () => {
      const rooms = {
        "!dm-room:example.org": { allow: true, skills: ["support"] },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!dm-room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("direct");
      expect(result.config).toBeDefined();
      // This room is explicitly configured, so it can be overridden from DM to group
    });

    it("indicates wildcard match (does NOT enable override)", () => {
      const rooms = {
        "*": { allow: true, skills: ["general"] },
      };

      const result = resolveMatrixRoomConfig({
        rooms,
        roomId: "!dm-room:example.org",
        aliases: [],
      });

      expect(result.matchSource).toBe("wildcard");
      // Wildcard should NOT override DM classification
    });

    it("provides config only for matched rooms (DMs without config get undefined)", () => {
      const rooms = {
        "!group-room:example.org": { allow: true, skills: ["project"] },
      };

      const dmResult = resolveMatrixRoomConfig({
        rooms,
        roomId: "!dm-room:example.org",
        aliases: [],
      });

      expect(dmResult.config).toBeUndefined();
      expect(dmResult.matchSource).toBeUndefined();
      // DMs without explicit config should not inherit any group config
    });
  });
});
