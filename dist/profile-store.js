import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeBaseUrl } from "./utils.js";
const CONFIG_DIR = ".workctl";
const LEGACY_CONFIG_DIR = ".kslog";
const CONFIG_FILE = "profiles.json";
export function defaultProfilesPath(homeDir = os.homedir()) {
    return path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
}
export function legacyProfilesPath(homeDir = os.homedir()) {
    return path.join(homeDir, LEGACY_CONFIG_DIR, CONFIG_FILE);
}
export async function migrateLegacyProfilesIfNeeded(filePath = defaultProfilesPath(), legacyFilePath = legacyProfilesPath()) {
    try {
        await fs.access(filePath);
        return false;
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
    let legacyContent;
    try {
        legacyContent = await fs.readFile(legacyFilePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, legacyContent, {
        encoding: "utf8",
        mode: 0o600
    });
    await fs.chmod(filePath, 0o600);
    return true;
}
export async function readProfiles(filePath = defaultProfilesPath()) {
    if (filePath === defaultProfilesPath()) {
        await migrateLegacyProfilesIfNeeded(filePath);
    }
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.profiles)) {
            throw new Error("profiles 字段必须是数组");
        }
        return {
            defaultProfile: parsed.defaultProfile,
            profiles: parsed.profiles
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { profiles: [] };
        }
        throw new Error(`读取 profile 配置失败：${error.message}`);
    }
}
export async function writeProfiles(profilesFile, filePath = defaultProfilesPath()) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, `${JSON.stringify(profilesFile, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
    });
    await fs.chmod(filePath, 0o600);
}
export async function upsertProfile(input, filePath = defaultProfilesPath()) {
    const name = input.name.trim();
    if (!name) {
        throw new Error("profile name 不能为空");
    }
    if (!input.username.trim()) {
        throw new Error("username 不能为空");
    }
    if (!input.password) {
        throw new Error("password 不能为空");
    }
    const config = await readProfiles(filePath);
    const now = new Date().toISOString();
    const existing = config.profiles.find((profile) => profile.name === name);
    const profile = {
        name,
        url: normalizeBaseUrl(input.url),
        username: input.username.trim(),
        password: input.password,
        redisPassword: existing?.redisPassword,
        insecure: Boolean(input.insecure),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };
    if (existing) {
        Object.assign(existing, profile);
    }
    else {
        config.profiles.push(profile);
    }
    if (input.setDefault ?? (config.profiles.length === 1)) {
        config.defaultProfile = name;
    }
    await writeProfiles(config, filePath);
    return profile;
}
export async function setProfileRedisPassword(name, redisPassword, filePath = defaultProfilesPath()) {
    if (!redisPassword) {
        throw new Error("Redis 密码不能为空");
    }
    const config = await readProfiles(filePath);
    const profile = config.profiles.find((item) => item.name === name);
    if (!profile) {
        throw new Error(`profile 不存在：${name}`);
    }
    profile.redisPassword = redisPassword;
    profile.updatedAt = new Date().toISOString();
    await writeProfiles(config, filePath);
}
export async function removeProfile(name, filePath = defaultProfilesPath()) {
    const config = await readProfiles(filePath);
    const before = config.profiles.length;
    config.profiles = config.profiles.filter((profile) => profile.name !== name);
    if (config.defaultProfile === name) {
        config.defaultProfile = config.profiles[0]?.name;
    }
    await writeProfiles(config, filePath);
    return config.profiles.length !== before;
}
export async function setDefaultProfile(name, filePath = defaultProfilesPath()) {
    const config = await readProfiles(filePath);
    if (!config.profiles.some((profile) => profile.name === name)) {
        throw new Error(`profile 不存在：${name}`);
    }
    config.defaultProfile = name;
    await writeProfiles(config, filePath);
}
export async function getProfile(name, filePath = defaultProfilesPath()) {
    const config = await readProfiles(filePath);
    return config.profiles.find((profile) => profile.name === name);
}
export function chooseDefaultProfile(config) {
    if (config.defaultProfile) {
        const defaultProfile = config.profiles.find((profile) => profile.name === config.defaultProfile);
        if (defaultProfile) {
            return defaultProfile;
        }
    }
    return config.profiles[0];
}
//# sourceMappingURL=profile-store.js.map