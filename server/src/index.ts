import { createApp } from "./app.js";
import { config } from "./config.js";
import { migrate, openDb } from "./db/connection.js";

const db = openDb(config.dbPath);
migrate(db);

createApp({ db }).listen(config.port, () => {
  console.log(`PropGuard API on http://localhost:${config.port}  (Swagger: http://localhost:${config.port}/docs)`);
  console.log(`DB: ${config.dbPath}`);
});
