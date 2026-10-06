// Grants or revokes the maintainer role. Requires shell access to the server and database.
//   bun run maintainer grant <email>
//   bun run maintainer revoke <email>
//   bun run maintainer list
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { user } from "../src/db/schema";

const [command, emailArg] = process.argv.slice(2);
const { db, sqlite } = createDb(loadConfig().databasePath);

function exit(message: string, code = 0): never {
  console[code ? "error" : "log"](message);
  sqlite.close();
  process.exit(code);
}

if (command === "list") {
  const rows = db.select({ email: user.email, name: user.name }).from(user).where(eq(user.role, "maintainer")).all();
  exit(rows.length ? rows.map((r) => `${r.email}\t${r.name}`).join("\n") : "No maintainers.");
}

if ((command !== "grant" && command !== "revoke") || !emailArg) {
  exit("Usage: bun run maintainer <grant|revoke> <email> | list", 1);
}

const email = emailArg.trim().toLowerCase();
const found = db.select({ id: user.id, emailVerified: user.emailVerified }).from(user).where(eq(user.email, email)).get();
if (!found) exit(`No account with email ${email}. The person must sign up first.`, 1);
if (command === "grant" && !found.emailVerified) exit(`${email} hasn't verified their email yet.`, 1);

db.update(user)
  .set({ role: command === "grant" ? "maintainer" : "user", updatedAt: new Date() })
  .where(eq(user.id, found.id))
  .run();
exit(command === "grant" ? `${email} is now a maintainer.` : `${email} is no longer a maintainer.`);
