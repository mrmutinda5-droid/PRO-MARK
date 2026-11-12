const { Pool } = require("pg");

const rawDatabaseUrl = process.env.DATABASE_URL;
const databaseUrl = rawDatabaseUrl
  ? rawDatabaseUrl.replace(/([?&])sslmode=[^&]*&?/i, "$1").replace(/[?&]$/, "")
  : rawDatabaseUrl;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
module.exports = { query: (text, params) => pool.query(text, params), pool };
