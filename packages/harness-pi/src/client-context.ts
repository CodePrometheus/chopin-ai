import { defineDoc, defineExtension, section, type Extension } from "@earendil-works/pi-durable";

/** What a client shows its user beside a conversation, in the client's own words, such as the page they are on. */
export const ClientContextDoc = defineDoc<{ text: string }>({
  kind: "chopin.client-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ text: "" }),
  checkpointWhen: () => false,
});

/** Gives the model the client's context as it stands at each request; nothing while the client has set none. */
export const clientContext: Extension = defineExtension({
  name: "chopin-client-context",
  sections: [section("client_context", async ({ read, conversationId }, context) => {
    const text = (await read.snapshot(ClientContextDoc, conversationId, context))?.text ?? "";
    return text === "" ? undefined : text;
  })],
});
