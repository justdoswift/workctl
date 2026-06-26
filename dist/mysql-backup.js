import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export const DEFAULT_MYSQL_PORT = 3306;
const MYSQL_COMMAND = "mysql";
const MYSQLDUMP_COMMAND = "mysqldump";
const HOMEBREW_MYSQL_CLIENT_BINS = [
    "/opt/homebrew/opt/mysql-client/bin",
    "/usr/local/opt/mysql-client/bin"
];
export function isValidDatabaseName(value) {
    return /^[A-Za-z0-9_$]+$/.test(value);
}
export function assertDatabaseName(value, label = "数据库名") {
    if (!isValidDatabaseName(value)) {
        throw new Error(`${label} 只支持字母、数字、下划线和 $`);
    }
}
export function escapeIdentifier(value) {
    assertDatabaseName(value);
    return `\`${value.replace(/`/g, "``")}\``;
}
export function escapeSqlString(value) {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
export function buildDefaultMySqlDestDatabase(source, now = new Date()) {
    return `${source.trim()}_${formatMySqlBackupTimestamp(now)}`;
}
function formatMySqlBackupTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        pad(date.getHours()),
        pad(date.getMinutes())
    ].join("");
}
export function buildMySqlEnv(connection, baseEnv = process.env) {
    const pathValue = [
        ...HOMEBREW_MYSQL_CLIENT_BINS,
        baseEnv.PATH
    ].filter(Boolean).join(":");
    return {
        ...baseEnv,
        PATH: pathValue,
        MYSQL_PWD: connection.password
    };
}
export function buildMySqlClientEnv(baseEnv = process.env) {
    const pathValue = [
        ...HOMEBREW_MYSQL_CLIENT_BINS,
        baseEnv.PATH
    ].filter(Boolean).join(":");
    return {
        ...baseEnv,
        PATH: pathValue
    };
}
export function buildMysqlCommand(connection, options = {}) {
    const args = [
        "--host",
        connection.host,
        "--port",
        String(connection.port),
        "--user",
        connection.username,
        "--protocol",
        "TCP",
        "--default-character-set",
        "utf8mb4"
    ];
    if (options.sql) {
        args.push("--batch", "--skip-column-names", "--execute", options.sql);
    }
    if (options.database) {
        assertDatabaseName(options.database);
        args.push(options.database);
    }
    return { command: MYSQL_COMMAND, args };
}
export function buildMysqldumpCommand(connection, source) {
    assertDatabaseName(source, "source 数据库名");
    return {
        command: MYSQLDUMP_COMMAND,
        args: [
            "--host",
            connection.host,
            "--port",
            String(connection.port),
            "--user",
            connection.username,
            "--protocol",
            "TCP",
            "--default-character-set",
            "utf8mb4",
            "--single-transaction",
            "--triggers",
            "--events",
            "--hex-blob",
            "--column-statistics=0",
            source
        ]
    };
}
export function validateBackupPreflight(source, dest, sourceExists, destExists) {
    assertDatabaseName(source, "source 数据库名");
    assertDatabaseName(dest, "dest 数据库名");
    if (source === dest) {
        throw new Error("source 和 dest 不能相同");
    }
    if (!sourceExists) {
        throw new Error(`source 数据库不存在：${source}`);
    }
    if (destExists) {
        throw new Error(`dest 数据库已存在：${dest}`);
    }
}
export async function backupMySqlDatabase(options) {
    const { connection, source, dest, onProgress } = options;
    assertDatabaseName(source, "source 数据库名");
    assertDatabaseName(dest, "dest 数据库名");
    await ensureMySqlCommandsAvailable();
    const sourceExists = await databaseExists(connection, source);
    const destExists = await databaseExists(connection, dest);
    validateBackupPreflight(source, dest, sourceExists, destExists);
    const totalTables = await countTables(connection, source);
    onProgress?.({ transferredBytes: 0, copiedTables: 0, totalTables });
    const defaults = await databaseDefaults(connection, source);
    await runMysqlSql(connection, buildCreateDatabaseSql(dest, defaults));
    return dumpAndRestore(connection, source, dest, totalTables, onProgress);
}
export function buildCreateDatabaseSql(database, defaults) {
    return [
        "CREATE DATABASE",
        escapeIdentifier(database),
        "DEFAULT CHARACTER SET",
        safeSqlName(defaults.charset, "charset"),
        "DEFAULT COLLATE",
        safeSqlName(defaults.collation, "collation")
    ].join(" ");
}
async function databaseExists(connection, database) {
    const sql = `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${escapeSqlString(database)}`;
    const value = await runMysqlSql(connection, sql);
    return value.trim() === "1";
}
export async function countTables(connection, database) {
    assertDatabaseName(database);
    const sql = `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${escapeSqlString(database)}`;
    const value = await runMysqlSql(connection, sql);
    return Number(value.trim()) || 0;
}
async function databaseDefaults(connection, database) {
    const sql = [
        "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME",
        "FROM information_schema.SCHEMATA",
        `WHERE SCHEMA_NAME = ${escapeSqlString(database)}`
    ].join(" ");
    const value = await runMysqlSql(connection, sql);
    const [charset, collation] = value.trim().split(/\t+/);
    return {
        charset: charset || "utf8mb4",
        collation: collation || "utf8mb4_0900_ai_ci"
    };
}
export async function listMissingMySqlClientCommands() {
    const checks = await Promise.all([
        commandIsAvailable(MYSQL_COMMAND, buildMySqlClientEnv()),
        commandIsAvailable(MYSQLDUMP_COMMAND, buildMySqlClientEnv())
    ]);
    return [
        checks[0] ? undefined : MYSQL_COMMAND,
        checks[1] ? undefined : MYSQLDUMP_COMMAND
    ].filter((value) => Boolean(value));
}
export async function ensureMySqlCommandsAvailable() {
    const missing = await listMissingMySqlClientCommands();
    if (missing.length > 0) {
        throw new Error(`找不到 ${missing.join("、")} 命令，请先安装 mysql-client`);
    }
}
export async function commandIsAvailable(command, env = process.env) {
    try {
        await runCommand({ command, args: ["--version"] }, undefined, { env });
        return true;
    }
    catch {
        return false;
    }
}
export function buildHomebrewInstallMysqlClientCommand() {
    return { command: "brew", args: ["install", "mysql-client"] };
}
async function runMysqlSql(connection, sql) {
    return runCommand(buildMysqlCommand(connection, { sql }), connection);
}
async function dumpAndRestore(connection, source, dest, totalTables, onProgress) {
    const dumpSpec = buildMysqldumpCommand(connection, source);
    const restoreSpec = buildMysqlCommand(connection, { database: dest });
    const env = buildMySqlEnv(connection);
    const dump = spawn(dumpSpec.command, dumpSpec.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const restore = spawn(restoreSpec.command, restoreSpec.args, { env, stdio: ["pipe", "ignore", "pipe"] });
    const dumpStderr = collectStreamText(dump.stderr);
    const restoreStderr = collectStreamText(restore.stderr);
    let transferredBytes = 0;
    let copiedTables = 0;
    const emitProgress = () => {
        onProgress?.({ transferredBytes, copiedTables, totalTables });
    };
    const poller = startTableCountPoller(connection, dest, (value) => {
        copiedTables = value;
        emitProgress();
    });
    const progress = new Transform({
        transform(chunk, _encoding, callback) {
            transferredBytes += chunk.length;
            emitProgress();
            callback(null, chunk);
        }
    });
    try {
        const pipePromise = pipeline(dump.stdout, progress, restore.stdin);
        const [dumpResult, restoreResult] = await Promise.all([
            waitForChild(dump, MYSQLDUMP_COMMAND),
            waitForChild(restore, MYSQL_COMMAND),
            pipePromise
        ]).then(async ([dumpCode, restoreCode]) => {
            const [dumpError, restoreError] = await Promise.all([dumpStderr, restoreStderr]);
            return [
                { code: dumpCode, stderr: dumpError },
                { code: restoreCode, stderr: restoreError }
            ];
        });
        copiedTables = await countTables(connection, dest);
        emitProgress();
        if (dumpResult.code !== 0) {
            throw new Error(`mysqldump 执行失败：${dumpResult.stderr.trim() || `退出码 ${dumpResult.code}`}`);
        }
        if (restoreResult.code !== 0) {
            throw new Error(`mysql 恢复失败：${restoreResult.stderr.trim() || `退出码 ${restoreResult.code}`}`);
        }
        return { transferredBytes, copiedTables, totalTables };
    }
    finally {
        poller.stop();
    }
}
function startTableCountPoller(connection, database, onCount) {
    let running = false;
    const poll = async () => {
        if (running) {
            return;
        }
        running = true;
        try {
            onCount(await countTables(connection, database));
        }
        catch {
            // Progress polling is best-effort; the dump/restore process owns success or failure.
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => {
        void poll();
    }, 1000);
    void poll();
    return {
        stop: () => clearInterval(timer)
    };
}
async function runCommand(spec, connection, options = {}) {
    const child = spawn(spec.command, spec.args, {
        env: connection ? buildMySqlEnv(connection, options.env ?? process.env) : (options.env ?? buildMySqlClientEnv()),
        stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = collectStreamText(child.stdout);
    const stderr = collectStreamText(child.stderr);
    const code = await waitForChild(child, spec.command);
    const [out, err] = await Promise.all([stdout, stderr]);
    if (code !== 0) {
        throw new Error(`${spec.command} 执行失败：${err.trim() || `退出码 ${code}`}`);
    }
    return out;
}
function collectStreamText(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}
function waitForChild(child, command) {
    return new Promise((resolve, reject) => {
        child.on("error", (error) => {
            if (error.code === "ENOENT") {
                reject(new Error(`找不到 ${command} 命令，请先安装 mysql-client`));
                return;
            }
            reject(error);
        });
        child.on("close", (code) => resolve(code ?? 1));
    });
}
function safeSqlName(value, label) {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
        throw new Error(`非法 ${label}：${value}`);
    }
    return value;
}
//# sourceMappingURL=mysql-backup.js.map