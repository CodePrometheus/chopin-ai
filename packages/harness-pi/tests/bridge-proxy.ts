import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { binaryCodec, type Message } from "@earendil-works/chord";
import { WebSocket, WebSocketServer } from "ws";

interface Traffic {
  link: number;
  direction: "client" | "server";
  message: Message;
  disconnect(): void;
}

/** Returning undefined forwards a frame unchanged; null drops it; a message replaces it. */
export async function proxy(target: string, intercept: (traffic: Traffic) => Message | null | undefined) {
  const listener = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(listener, "listening");
  const upstreams = new Set<WebSocket>();
  let sequence = 0;
  let failure: unknown;
  listener.on("connection", (client, request) => {
    const link = ++sequence;
    const upstream = new WebSocket(target, { headers: { authorization: request.headers.authorization ?? "" } });
    upstreams.add(upstream);
    const waiting: Buffer[] = [];
    const disconnect = () => { client.terminate(); upstream.terminate(); };
    const forward = (direction: Traffic["direction"], bytes: Buffer) => {
      try {
        const changed = intercept({ link, direction, message: binaryCodec.decode(bytes), disconnect });
        if (changed === null) return;
        const destination = direction === "client" ? upstream : client;
        if (destination.readyState === WebSocket.OPEN) destination.send(changed === undefined ? bytes : binaryCodec.encode(changed));
      } catch (error) { failure ??= error; disconnect(); }
    };
    client.on("message", (bytes) => {
      if (!Buffer.isBuffer(bytes)) throw new Error("proxy expects binary buffers");
      if (upstream.readyState === WebSocket.CONNECTING) waiting.push(bytes);
      else forward("client", bytes);
    });
    upstream.on("open", () => { for (const bytes of waiting.splice(0)) forward("client", bytes); });
    upstream.on("message", (bytes) => {
      if (!Buffer.isBuffer(bytes)) throw new Error("proxy expects binary buffers");
      forward("server", bytes);
    });
    client.on("close", () => upstream.terminate());
    upstream.on("close", () => { upstreams.delete(upstream); client.terminate(); });
    client.on("error", disconnect);
    upstream.on("error", disconnect);
  });
  return {
    url: `ws://127.0.0.1:${(listener.address() as AddressInfo).port}/`,
    close: async () => {
      for (const socket of listener.clients) socket.terminate();
      for (const socket of upstreams) socket.terminate();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      if (failure !== undefined) throw failure;
    },
  };
}
