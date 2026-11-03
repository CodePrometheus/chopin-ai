// Run as `loopback-connect <port> serve --token <hex>`, where the execution daemon would be: hands the token to the
// workspace listener on that loopback port, then joins this process's standard input and output to the daemon it starts.
import { connect } from "node:net";

const [port, verb, flag, token] = process.argv.slice(2);
if (!/^\d{1,5}$/.test(port ?? "") || verb !== "serve" || flag !== "--token" || token === undefined) {
  process.stderr.write("usage: loopback-connect <port> serve --token <hex>\n");
  process.exit(2);
}
const link = connect(Number(port), "127.0.0.1", () => {
  link.write(`${token}\n`);
  process.stdin.pipe(link);
  link.pipe(process.stdout);
});
link.on("error", (error) => process.stderr.write(`loopback-connect: ${error.message}\n`));
// The daemon's last answer is written out whole before this process ends.
link.on("close", (failed) => process.stdout.write("", () => process.exit(failed ? 1 : 0)));
