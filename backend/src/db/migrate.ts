import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import { config } from "../config.js"

/** Applies pending migrations, then exits. Run before the server starts. */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL })

await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" })
console.log("migrations applied")

await pool.end()
