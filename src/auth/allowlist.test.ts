import { beforeEach, describe, expect, it } from "vitest";
import { hasAdminUsers, isUserAdmin, isUserAllowed, setAdminUsers, setAllowedUsers } from "./allowlist.js";

describe("allowlist", () => {
  beforeEach(() => {
    setAllowedUsers([]);
    setAdminUsers([]);
  });

  it("allows all users when allowlist is empty", () => {
    expect(isUserAllowed("user-a")).toBe(true);
  });

  it("restricts access when allowlist is configured", () => {
    setAllowedUsers(["user-a"]);
    expect(isUserAllowed("user-a")).toBe(true);
    expect(isUserAllowed("user-b")).toBe(false);
  });

  it("tracks admin users separately", () => {
    expect(hasAdminUsers()).toBe(false);
    setAdminUsers(["admin-a"]);
    expect(hasAdminUsers()).toBe(true);
    expect(isUserAdmin("admin-a")).toBe(true);
    expect(isUserAdmin("user-a")).toBe(false);
  });
});
