import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pool;

function getPool() {
  if (pool) return pool;
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error('Missing database settings. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in .env');
  }
  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD ?? '',
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 15_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reaction_role_panels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, title VARCHAR(100) NOT NULL, description TEXT NOT NULL,
    options TEXT NOT NULL, channel VARCHAR(32), message VARCHAR(32),
    UNIQUE KEY reaction_role_message (message)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    guild VARCHAR(32) NOT NULL, \`key\` VARCHAR(64) NOT NULL, value TEXT,
    PRIMARY KEY (guild, \`key\`)
  )`,
  `CREATE TABLE IF NOT EXISTS roblox_links (
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    roblox_id BIGINT NOT NULL UNIQUE,
    roblox_name VARCHAR(64) NOT NULL,
    verified_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS roblox_pending (
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    roblox_id BIGINT NOT NULL,
    roblox_name VARCHAR(64) NOT NULL,
    code VARCHAR(128) NOT NULL,
    expires BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS surveys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, channel VARCHAR(32), message VARCHAR(32),
    question TEXT NOT NULL, options TEXT NOT NULL,
    author VARCHAR(32) NOT NULL, ends_at BIGINT, closed TINYINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS survey_votes (
    survey_id INT NOT NULL, user_id VARCHAR(32) NOT NULL, \`option\` INT NOT NULL,
    PRIMARY KEY (survey_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS giveaways (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, channel VARCHAR(32) NOT NULL, message VARCHAR(32),
    prize VARCHAR(200) NOT NULL, description TEXT, host VARCHAR(32) NOT NULL,
    winner_count TINYINT NOT NULL DEFAULT 1, eligibility VARCHAR(16) NOT NULL DEFAULT 'verified',
    starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active', rerolling TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    INDEX giveaways_due (status, starts_at, ends_at)
  )`,
  `CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INT NOT NULL, user_id VARCHAR(32) NOT NULL, joined_at BIGINT NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS giveaway_winners (
    giveaway_id INT NOT NULL, user_id VARCHAR(32) NOT NULL, round INT NOT NULL, selected_at BIGINT NOT NULL,
    PRIMARY KEY (giveaway_id, user_id),
    INDEX giveaway_winner_round (giveaway_id, round)
  )`,
  `CREATE TABLE IF NOT EXISTS links (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, label VARCHAR(100) NOT NULL, url VARCHAR(512) NOT NULL,
    emoji VARCHAR(64), description TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, code VARCHAR(128) NOT NULL, uses INT NOT NULL, reward TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    goal INT, channel VARCHAR(32), message VARCHAR(32), reveal_message VARCHAR(32),
    progress INT NOT NULL DEFAULT 0, created_by VARCHAR(32)
  )`,
  `CREATE TABLE IF NOT EXISTS suggestions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, channel VARCHAR(32), message VARCHAR(32), author VARCHAR(32) NOT NULL,
    author_name VARCHAR(100), author_avatar VARCHAR(512),
    content TEXT NOT NULL, image VARCHAR(1024),
    status VARCHAR(16) NOT NULL DEFAULT 'pending', reason TEXT, reviewer VARCHAR(32)
  )`,
  `CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INT NOT NULL, user_id VARCHAR(32) NOT NULL, vote INT NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS bug_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, channel VARCHAR(32), message VARCHAR(32), thread VARCHAR(32),
    author VARCHAR(32) NOT NULL, title VARCHAR(256) NOT NULL, description TEXT NOT NULL,
    steps TEXT, platform VARCHAR(100),
    status VARCHAR(16) NOT NULL DEFAULT 'open', handler VARCHAR(32), created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    message VARCHAR(32) NOT NULL PRIMARY KEY,
    guild VARCHAR(32) NOT NULL, channel VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL,
    author VARCHAR(32) NOT NULL, likes INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
  )`,
];

export async function initDb() {
  const p = getPool();
  for (const ddl of SCHEMA) await p.query(ddl);
  const [columns] = await p.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'giveaways' AND column_name = 'description' LIMIT 1",
  );
  if (!columns.length) await p.query('ALTER TABLE giveaways ADD COLUMN description TEXT NULL AFTER prize');
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = undefined;
}

export async function get(sql, ...params) {
  const [rows] = await getPool().query(sql, params);
  return rows[0];
}

export async function all(sql, ...params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

// Keeps the { changes, lastInsertRowid } shape used across the modules.
export async function run(sql, ...params) {
  const [res] = await getPool().query(sql, params);
  return { changes: res.affectedRows ?? 0, lastInsertRowid: res.insertId ?? 0 };
}

const settingsCache = new Map();
const SETTINGS_TTL = 60_000;

export async function getSetting(guild, key, fallback = null) {
  const id = `${guild}/${key}`;
  const hit = settingsCache.get(id);
  if (hit && hit.until > Date.now()) return hit.value ?? fallback;
  const row = await get('SELECT value FROM settings WHERE guild = ? AND `key` = ?', guild, key);
  settingsCache.set(id, { value: row?.value ?? null, until: Date.now() + SETTINGS_TTL });
  return row?.value ?? fallback;
}

export async function setSetting(guild, key, value) {
  settingsCache.delete(`${guild}/${key}`);
  if (value === null || value === undefined) {
    await run('DELETE FROM settings WHERE guild = ? AND `key` = ?', guild, key);
  } else {
    await run(
      'INSERT INTO settings (guild, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      guild, key, String(value),
    );
  }
}
