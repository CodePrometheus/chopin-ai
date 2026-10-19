import { randomUUID } from "node:crypto";
import type { AuthCheck, AuthEvent, AuthPrompt, AuthType, Models, Provider } from "@earendil-works/pi-ai";
import { Container, ProcessTerminal, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { Asker, Declined } from "./ask.js";
import { openBrowser } from "./browser.js";
import { readSettings, writeSettings } from "./home.js";
import type { ModelRef } from "./model.js";

/**
 * Connects a provider, as the user picks among every provider and way in, each marked with whether it is set up: by
 * its sign-in or by a key entered. `providerId` narrows the list to that provider's ways. Resolves the provider's id
 * once its credential is kept.
 */
export async function signIn(models: Models, asker: Asker, providerId?: string): Promise<string> {
  const options = (await Promise.all(models.getProviders().map(async (provider) => {
    const check = await models.checkAuth(provider.id);
    return ways(provider).map((way) => ({ provider, type: way.type, label: `${provider.name} [${way.label}]`, description: setUp(check) }));
  }))).flat().filter((option) => providerId === undefined || option.provider.id === providerId);
  if (options.length === 0) throw new Error(providerId === undefined ? "no provider takes a sign-in here" : `${providerId} is no provider that takes a sign-in here`);
  options.sort((a, b) => a.label.localeCompare(b.label));
  const only = options.length === 1 ? options[0] : undefined;
  const picked = only ?? options[Number(await asker.choose("Select a provider to connect", options.map((option, i) => ({
    value: String(i), label: option.label, description: option.description,
  }))))];
  if (picked === undefined) throw new Error("no provider was picked");
  const settings = await readSettings();
  const deviceId = settings.deviceId ?? randomUUID();
  if (settings.deviceId === undefined) await writeSettings({ ...settings, deviceId });
  await models.login(picked.provider.id, picked.type, {
    prompt: (prompt) => answer(asker, prompt),
    notify: (event) => tell(asker, event),
  }, { agentName: "chopin", getDeviceId: () => deviceId });
  return picked.provider.id;
}

/** The item of a model list that goes back to connecting a provider. */
const CONNECT = "\0connect";

/**
 * A model the user picks among those the connected providers offer: the one in use first and marked, then the
 * default, then the rest by provider. The first item goes back to connecting a provider, and then to the list again.
 */
export async function chooseModel(models: Models, asker: Asker, inUse?: ModelRef, preset?: ModelRef): Promise<ModelRef> {
  const same = (a: ModelRef | undefined, b: { provider: string; id: string }) => a?.provider === b.provider && a.modelId === b.id;
  const rank = (model: { provider: string; id: string }) => (same(inUse, model) ? 0 : same(preset, model) ? 1 : 2);
  for (;;) {
    const available = [...await models.getAvailable()]
      .sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    const picked = await asker.choose("Select a model", [
      { value: CONNECT, label: "← Connect a provider", description: "its sign-in or an API key" },
      ...available.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${same(inUse, model) ? "✓ " : ""}${model.id}`,
        description: `[${model.provider}]${same(preset, model) ? " · default" : ""}`,
      })),
    ]);
    if (picked === CONNECT) {
      await signIn(models, asker).catch((error: unknown) => {
        // Turning the sign-in down comes back to the list.
        if (!(error instanceof Declined)) throw error;
      });
      continue;
    }
    const [provider = "", ...rest] = picked.split("/");
    return { provider, modelId: rest.join("/") };
  }
}

/** Runs `work` on a screen of its own, for questions asked before or outside a conversation. */
export async function onScreen<T>(work: (asker: Asker) => Promise<T>, terminal: Terminal = new ProcessTerminal()): Promise<T> {
  const tui = new TuiMainScreen(terminal);
  const slot = new Container();
  tui.addChild(slot);
  tui.start();
  try {
    return await work(new Asker(tui, slot, () => {}));
  } finally {
    tui.stop();
  }
}

/** The ways into a provider here: its sign-in, labelled by the access it gives, and a key entered. */
function ways(provider: Provider): { type: AuthType; label: string }[] {
  const { oauth, apiKey } = provider.auth;
  return [
    ...(oauth === undefined ? [] : [{ type: "oauth" as const, label: oauth.isSubscription === false ? "account" : "subscription" }]),
    ...(apiKey?.login === undefined ? [] : [{ type: "api_key" as const, label: "API key" }]),
  ];
}

/** Whether a provider is set up, and from where when that is a variable. */
function setUp(check: AuthCheck | undefined): string {
  if (check === undefined) return "not configured";
  return check.source !== undefined && /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(check.source) ? `✓ env: ${check.source}` : "✓ configured";
}

function answer(asker: Asker, prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const items = prompt.options.map((option) => ({ value: option.id, label: option.label, ...(option.description && { description: option.description }) }));
    return asker.choose(prompt.message, items, prompt.signal);
  }
  return asker.enter(prompt.message, prompt.type === "secret", prompt.signal);
}

function tell(asker: Asker, event: AuthEvent): void {
  switch (event.type) {
    case "info":
      asker.tell([event.message, ...(event.links ?? []).map((link) => `${link.label ?? "More"}: ${link.url}`)].join("\n"));
      return;
    case "auth_url":
      openBrowser(new URL(event.url));
      asker.tell(`Sign in in the browser; if none opened, visit:\n${event.url}${event.instructions === undefined ? "" : `\n${event.instructions}`}`);
      return;
    case "device_code":
      asker.tell(`Enter the code ${event.userCode} at ${event.verificationUri}`);
      return;
    case "progress":
      asker.tell(event.message);
      return;
  }
}
