import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
});

export async function checkDatabase() {
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0].now;
}
