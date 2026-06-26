import { describe, expect, it } from "vitest";

import {
  buildCreateDatabaseSql,
  buildDefaultMySqlDestDatabase,
  buildHomebrewInstallMysqlClientCommand,
  buildMySqlClientEnv,
  buildMySqlEnv,
  buildMysqlCommand,
  buildMysqldumpCommand,
  escapeIdentifier,
  escapeSqlString,
  isValidDatabaseName,
  validateBackupPreflight,
  type MySqlConnection
} from "../src/mysql-backup.js";

describe("mysql backup", () => {
  const connection: MySqlConnection = {
    host: "192.168.7.182",
    port: 3306,
    username: "root",
    password: "secret-password"
  };

  it("validates database names and escapes identifiers", () => {
    expect(isValidDatabaseName("lxzsdb_bak2")).toBe(true);
    expect(isValidDatabaseName("bad-db")).toBe(false);
    expect(isValidDatabaseName("bad name")).toBe(false);
    expect(escapeIdentifier("lxzsdb_bak2")).toBe("`lxzsdb_bak2`");
    expect(escapeSqlString("a'b\\c")).toBe("'a\\'b\\\\c'");
  });

  it("builds timestamped default destination database names", () => {
    expect(buildDefaultMySqlDestDatabase("lxzsdb_bak", new Date(2026, 5, 26, 9, 48))).toBe(
      "lxzsdb_bak_202606260948"
    );
  });

  it("builds mysql commands without leaking passwords in args", () => {
    const command = buildMysqlCommand(connection, {
      sql: "SELECT 1",
      database: "lxzsdb_bak2"
    });

    expect(command.command).toBe("mysql");
    expect(command.args).toContain("--execute");
    expect(command.args).toContain("lxzsdb_bak2");
    expect(command.args.join(" ")).not.toContain(connection.password);
  });

  it("builds mysqldump commands without --databases so restore can target dest", () => {
    const command = buildMysqldumpCommand(connection, "lxzsdb_bak");

    expect(command.command).toBe("mysqldump");
    expect(command.args).toContain("--single-transaction");
    expect(command.args).not.toContain("--routines");
    expect(command.args).toContain("--column-statistics=0");
    expect(command.args).toContain("lxzsdb_bak");
    expect(command.args).not.toContain("--databases");
    expect(command.args.join(" ")).not.toContain(connection.password);
  });

  it("passes passwords only through MYSQL_PWD env", () => {
    const env = buildMySqlEnv(connection, { PATH: "/bin" });

    expect(env.MYSQL_PWD).toBe(connection.password);
    expect(env.PATH).toContain("/bin");
    expect(env.PATH).toContain("/opt/homebrew/opt/mysql-client/bin");
  });

  it("supports empty passwords in MYSQL_PWD env", () => {
    const env = buildMySqlEnv({ ...connection, password: "" }, { PATH: "/bin" });

    expect(env.MYSQL_PWD).toBe("");
  });

  it("adds Homebrew mysql-client paths and builds install command", () => {
    const env = buildMySqlClientEnv({ PATH: "/bin" });

    expect(env.PATH).toContain("/opt/homebrew/opt/mysql-client/bin");
    expect(env.PATH).toContain("/usr/local/opt/mysql-client/bin");
    expect(buildHomebrewInstallMysqlClientCommand()).toEqual({
      command: "brew",
      args: ["install", "mysql-client"]
    });
  });

  it("rejects missing source and existing dest during preflight", () => {
    expect(() => validateBackupPreflight("source", "dest", false, false)).toThrow("source 数据库不存在");
    expect(() => validateBackupPreflight("source", "dest", true, true)).toThrow("dest 数据库已存在");
    expect(() => validateBackupPreflight("same", "same", true, false)).toThrow("source 和 dest 不能相同");
  });

  it("builds create database sql with source defaults", () => {
    expect(
      buildCreateDatabaseSql("lxzsdb_bak2", {
        charset: "utf8mb4",
        collation: "utf8mb4_0900_ai_ci"
      })
    ).toBe("CREATE DATABASE `lxzsdb_bak2` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_0900_ai_ci");
  });
});
