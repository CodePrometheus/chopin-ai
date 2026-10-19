import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { readSettings } from "./home.js";

/** This machine itself, which chopin's own clients reach and no proxy can stand in for. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Sends every request of this process, to models, sign-ins and MCP servers alike, through the proxy that
 * HTTP_PROXY and HTTPS_PROXY name, or `httpProxy` in the settings when they name none, sparing NO_PROXY's hosts and
 * this machine. Fetch and its dispatcher then come from one implementation, so responses decode as they were sent.
 */
export async function useConfiguredProxy(): Promise<void> {
  const { httpProxy } = await readSettings();
  if (httpProxy !== undefined && httpProxy.trim() !== "") {
    process.env.HTTP_PROXY ??= httpProxy.trim();
    process.env.HTTPS_PROXY ??= httpProxy.trim();
  }
  const spared = process.env.NO_PROXY ?? process.env.no_proxy;
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: [...(spared === undefined || spared === "" ? [] : [spared]), ...LOOPBACK].join(",") }));
  install();
}
