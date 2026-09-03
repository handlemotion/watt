import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

const connectionString = process.env.WATT_PLANETSCALE_DATABASE_URL;

if (!connectionString) {
  throw new Error("WATT_PLANETSCALE_DATABASE_URL is required");
}

const client = postgres(connectionString, { max: 1 });

try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
} finally {
  await client.end();
}
