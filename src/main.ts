import { createApp } from "./server";

const port = Number(process.env.PORT ?? 3000);
const app = createApp(process.env.DB_PATH ?? "work/votes.sqlite");

Bun.serve({
  port,
  fetch: app.fetch
});

console.log(`Voting app running at http://localhost:${port}`);
