import { appendFile, readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const path = process.env.CHOPIN_MCP_FIXTURE_FILE;
if (path === undefined) throw new Error("fixture file is required");
const server = new McpServer({ name: "file-fixture", version: "1.0.0" });
server.registerTool("read_fixture", { description: "Read this fixture's file" }, async () => {
  const text = await readFile(path, "utf8");
  await appendFile(`${path}.calls`, `${process.pid}\n`);
  return { content: [{ type: "text", text }] };
});
await server.connect(new StdioServerTransport());
