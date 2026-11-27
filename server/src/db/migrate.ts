import { config } from "../config.js";
import { migrate, openDb } from "./connection.js";

const db = openDb(config.dbPath);
const applied = migrate(db);
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date.");
console.log(`DB: ${config.dbPath}`);
