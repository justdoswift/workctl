import type { ProfilesFile, SavedProfile } from "./types.js";
export declare function defaultProfilesPath(homeDir?: string): string;
export declare function legacyProfilesPath(homeDir?: string): string;
export declare function migrateLegacyProfilesIfNeeded(filePath?: string, legacyFilePath?: string): Promise<boolean>;
export declare function readProfiles(filePath?: string): Promise<ProfilesFile>;
export declare function writeProfiles(profilesFile: ProfilesFile, filePath?: string): Promise<void>;
export declare function upsertProfile(input: {
    name: string;
    url: string;
    username: string;
    password: string;
    insecure?: boolean;
    setDefault?: boolean;
}, filePath?: string): Promise<SavedProfile>;
export declare function setProfileRedisPassword(name: string, redisPassword: string, filePath?: string): Promise<void>;
export declare function removeProfile(name: string, filePath?: string): Promise<boolean>;
export declare function setDefaultProfile(name: string, filePath?: string): Promise<void>;
export declare function getProfile(name: string, filePath?: string): Promise<SavedProfile | undefined>;
export declare function chooseDefaultProfile(config: ProfilesFile): SavedProfile | undefined;
