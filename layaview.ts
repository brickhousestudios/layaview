// Layaview: a local visualizer for Laya decisions, with a live view of every call.
//   node layaview.ts [--port 4777] [--dir ~/.local/share/layaview] [--laya-endpoint http://127.0.0.1:4778/v1/systemone]
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createJeview } from "./src/jeview.ts";

const { values } = parseArgs({ options: {
  port: { type: "string", default: "4777" },
  dir: { type: "string", default: join(homedir(), ".local/share/layaview") },
  "laya-endpoint": { type: "string" },
  "jev-endpoint": { type: "string" },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Usage: node layaview.ts [--port 4777] [--dir ~/.local/share/layaview] [--laya-endpoint URL]");
if (values["laya-endpoint"] && values["jev-endpoint"]) throw Error("Use --laya-endpoint; --jev-endpoint is only a compatibility alias and cannot be combined with it.");
const layaEndpoint = values["laya-endpoint"] ?? values["jev-endpoint"];
const { server, store } = createJeview({ dir: values.dir, port, ...(layaEndpoint ? { layaEndpoint } : {}) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); process.exit(0); });
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE"
    ? `Port ${port} is already in use. If Layaview is already running, open http://127.0.0.1:${port}/; otherwise start this one on another port: --port ${port + 1}`
    : `Layaview could not start: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({
  viewer: `http://127.0.0.1:${port}/`,
  send_laya_requests_to: `http://127.0.0.1:${port}/v1/systemone`,
  laya_endpoint: layaEndpoint ?? "http://127.0.0.1:4778/v1/systemone",
  database: store.database,
  recorded: store.count(),
})));
