import { drizzle } from "drizzle-orm/node-postgres"
import { config } from "../config.js"
import { createPool } from "./pool.js"
import * as schema from "./schema.js"

export const pool = createPool(config.DATABASE_URL)

export const db = drizzle(pool, { schema })

export type Db = typeof db
export * as schema from "./schema.js"
