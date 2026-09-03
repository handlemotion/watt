import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabase(env: CloudflareBindings) {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    prepare: false,
    max: 1,
  });
  return { client, db: drizzle(client) };
}

export type CloudDatabase = ReturnType<typeof createDatabase>["db"];
