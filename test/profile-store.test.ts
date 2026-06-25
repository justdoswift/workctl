import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chooseDefaultProfile,
  migrateLegacyProfilesIfNeeded,
  readProfiles,
  removeProfile,
  setDefaultProfile,
  setProfileRedisConfig,
  setProfileRedisPassword,
  upsertProfile
} from "../src/profile-store.js";

describe("profile store", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "workctl-profile-"));
    filePath = path.join(dir, "profiles.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates and reads profiles with 0600 permissions", async () => {
    await upsertProfile(
      {
        name: "测试环境",
        url: "192.168.7.191:30880",
        username: "admin",
        password: "secret",
        setDefault: true
      },
      filePath
    );

    const config = await readProfiles(filePath);
    const stat = await fs.stat(filePath);

    expect(config.defaultProfile).toBe("测试环境");
    expect(config.profiles[0]).toMatchObject({
      name: "测试环境",
      url: "http://192.168.7.191:30880",
      username: "admin",
      password: "secret"
    });
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("updates, defaults, and removes profiles", async () => {
    await upsertProfile({ name: "开发", url: "http://dev", username: "u", password: "p" }, filePath);
    await upsertProfile({ name: "生产", url: "http://prod", username: "u2", password: "p2" }, filePath);
    await setDefaultProfile("生产", filePath);

    let config = await readProfiles(filePath);
    expect(chooseDefaultProfile(config)?.name).toBe("生产");

    expect(await removeProfile("生产", filePath)).toBe(true);
    config = await readProfiles(filePath);
    expect(config.defaultProfile).toBe("开发");
  });

  it("saves redis passwords on profiles and preserves them during profile updates", async () => {
    await upsertProfile({ name: "开发", url: "http://dev", username: "u", password: "p" }, filePath);
    await setProfileRedisConfig(
      "开发",
      {
        redisHost: "redis.tax-component",
        redisPort: 6379,
        redisDb: 0,
        redisPassword: "redis-secret"
      },
      filePath
    );
    await upsertProfile({ name: "开发", url: "http://dev-new", username: "u2", password: "p2" }, filePath);

    const config = await readProfiles(filePath);
    expect(config.profiles[0]).toMatchObject({
      name: "开发",
      url: "http://dev-new",
      username: "u2",
      password: "p2",
      redisHost: "redis.tax-component",
      redisPort: 6379,
      redisDb: 0,
      redisPassword: "redis-secret"
    });
  });

  it("can update just the redis password", async () => {
    await upsertProfile({ name: "开发", url: "http://dev", username: "u", password: "p" }, filePath);
    await setProfileRedisPassword("开发", "redis-secret", filePath);

    const config = await readProfiles(filePath);
    expect(config.profiles[0]?.redisPassword).toBe("redis-secret");
  });

  it("migrates legacy profiles when the new file is missing", async () => {
    const legacyFilePath = path.join(dir, "legacy", "profiles.json");
    await fs.mkdir(path.dirname(legacyFilePath), { recursive: true });
    await fs.writeFile(
      legacyFilePath,
      JSON.stringify({
        defaultProfile: "测试环境",
        profiles: [
          {
            name: "测试环境",
            url: "http://192.168.7.191:30880",
            username: "admin",
            password: "secret",
            insecure: false,
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          }
        ]
      })
    );

    await expect(migrateLegacyProfilesIfNeeded(filePath, legacyFilePath)).resolves.toBe(true);

    const config = await readProfiles(filePath);
    const stat = await fs.stat(filePath);
    const legacyContent = await fs.readFile(legacyFilePath, "utf8");

    expect(config.defaultProfile).toBe("测试环境");
    expect(config.profiles[0]?.username).toBe("admin");
    expect(stat.mode & 0o777).toBe(0o600);
    expect(legacyContent).toContain("测试环境");
  });

  it("does not overwrite an existing profile file during migration", async () => {
    const legacyFilePath = path.join(dir, "legacy", "profiles.json");
    await upsertProfile({ name: "新环境", url: "http://new", username: "new", password: "p" }, filePath);
    await fs.mkdir(path.dirname(legacyFilePath), { recursive: true });
    await fs.writeFile(
      legacyFilePath,
      JSON.stringify({
        profiles: [{ name: "旧环境", url: "http://old", username: "old", password: "p" }]
      })
    );

    await expect(migrateLegacyProfilesIfNeeded(filePath, legacyFilePath)).resolves.toBe(false);

    const config = await readProfiles(filePath);
    expect(config.profiles.map((profile) => profile.name)).toEqual(["新环境"]);
  });

  it("returns an empty config when there is no profile file to migrate", async () => {
    const legacyFilePath = path.join(dir, "missing", "profiles.json");

    await expect(migrateLegacyProfilesIfNeeded(filePath, legacyFilePath)).resolves.toBe(false);
    await expect(readProfiles(filePath)).resolves.toEqual({ profiles: [] });
  });
});
