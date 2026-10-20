import { randomUUID } from "node:crypto";
import type { Api, AuthEvent, AuthPrompt, AuthType, Model } from "@earendil-works/pi-ai";
import {
  ExtensionSelectorComponent,
  initTheme,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  type ModelRuntime,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TuiMainScreen,
  type Component,
  type Focusable,
  type Terminal,
} from "@earendil-works/pi-tui";
import { stageIn, type Stage } from "./ask.js";
import { changeSettings, readSettings } from "./home.js";
import type { ModelRef } from "./model.js";
import { style } from "./theme.js";
import { deepPrintable, oneRow } from "./transcript.js";

type ProviderOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];

/**
 * Connects a provider as pi does: every provider and way in, each marked with whether it is set up, then the provider's
 * own sign-in or key entry. `providerId` narrows the list to that provider. Resolves the provider's id once its
 * credential is kept, or undefined when the user backs out or `signal` gives up, which also ends what the sign-in
 * keeps running, such as a server waiting for the browser.
 */
export async function signIn(stage: Stage, runtime: ModelRuntime, providerId?: string, signal?: AbortSignal): Promise<string | undefined> {
  const options = loginOptions(runtime).filter((option) => providerId === undefined || option.id === providerId);
  if (options.length === 0) throw new Error(providerId === undefined ? "no provider takes a sign-in here" : `${providerId} is no provider that takes a sign-in here`);
  const picked = options.length === 1 ? options[0] : await choose(stage, "login", options);
  if (picked === undefined) return undefined;
  const dialog = new LoginDialogComponent(stage.tui, picked.id, () => {}, picked.name);
  stage.show(dialog);
  const settings = await readSettings();
  const deviceId = settings.deviceId ?? randomUUID();
  if (settings.deviceId === undefined) await changeSettings({ deviceId });
  const cancelled = signal === undefined ? dialog.signal : AbortSignal.any([dialog.signal, signal]);
  try {
    await runtime.login(picked.id, picked.authType, {
      signal: cancelled,
      prompt: (prompt) => answer(stage, dialog, prompt),
      notify: (event) => tell(dialog, event),
    }, { agentName: "chopin", getDeviceId: () => deviceId });
    return picked.id;
  } catch (error) {
    if (cancelled.aborted || (error instanceof Error && error.message === "Login cancelled")) return undefined;
    throw error;
  } finally {
    stage.restore();
  }
}

/** Removes a credential kept here, as pi does; resolves the provider's id, or undefined when the user backs out. */
export async function signOut(stage: Stage, runtime: ModelRuntime, providerId?: string): Promise<string | undefined> {
  const stored = await runtime.listCredentials();
  if (stored.length === 0) throw new Error("nothing is signed in here; a key in an environment variable stays until it is unset");
  const options: ProviderOption[] = stored.map(({ providerId: id, type }) => {
    const provider = runtime.getProvider(id);
    return { id, name: provider?.name ?? id, authType: type, status: { type, source: "stored credential" }, subscription: provider?.auth.oauth?.isSubscription === true };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const picked = providerId === undefined ? await choose(stage, "logout", options) : options.find((option) => option.id === providerId);
  if (picked === undefined) {
    if (providerId === undefined) return undefined;
    throw new Error(`nothing is signed in here for ${providerId}`);
  }
  await runtime.logout(picked.id);
  return picked.id;
}

/**
 * A model picked in pi's model selector, among those the connected providers offer or only those `scoped` names, with
 * the one in use and the default marked; undefined when the user backs out.
 */
export function pickModel(
  stage: Stage,
  runtime: ModelRuntime,
  inUse?: ModelRef,
  preset?: ModelRef,
  scoped: readonly ScopedModel[] = [],
): Promise<ModelRef | undefined> {
  return new Promise((resolve) => {
    const done = (model: Model<Api> | undefined) => {
      stage.restore();
      selector.dispose();
      resolve(model === undefined ? undefined : { provider: model.provider, modelId: model.id });
    };
    const current = inUse === undefined ? undefined : runtime.getModel(inUse.provider, inUse.modelId);
    const selector = new ModelSelectorComponent(stage.tui, current, runtime, scoped, done, () => done(undefined), undefined, done,
      preset === undefined ? undefined : { provider: preset.provider, id: preset.modelId });
    stage.show(selector);
  });
}

/** Runs `work` on a screen of its own, for dialogs before or outside a conversation. */
export async function onScreen<T>(work: (stage: Stage) => Promise<T>, terminal: Terminal = new ProcessTerminal()): Promise<T> {
  initTheme();
  const tui = new TuiMainScreen(terminal);
  const slot = new Container();
  tui.addChild(slot);
  tui.start();
  try {
    return await work(stageIn(tui, slot));
  } finally {
    tui.stop();
  }
}

/** Every provider's ways in, each marked with whether and how it is set up, as pi lists them for /login. */
function loginOptions(runtime: ModelRuntime): ProviderOption[] {
  return runtime.getProviders().flatMap((provider) => {
    const auth = runtime.getProviderAuthStatus(provider.id);
    const status = auth.configured ? { type: runtime.isUsingOAuth(provider.id) ? "oauth" as const : "api_key" as const, source: auth.label ?? auth.source } : undefined;
    const subscription = provider.auth.oauth?.isSubscription === true;
    return [
      ...(provider.auth.oauth === undefined ? [] : [{ id: provider.id, name: provider.name, authType: "oauth" as const, method: provider.auth.oauth, status, subscription }]),
      ...(provider.auth.apiKey?.login === undefined ? [] : [{ id: provider.id, name: provider.name, authType: "api_key" as const, method: provider.auth.apiKey, status, subscription }]),
    ];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function choose(stage: Stage, mode: "login" | "logout", options: ProviderOption[]): Promise<ProviderOption | undefined> {
  return new Promise((resolve) => {
    const selector = new OAuthSelectorComponent(mode, options, (id, authType) => {
      stage.restore();
      resolve(options.find((option) => option.id === id && option.authType === authType));
    }, () => {
      stage.restore();
      resolve(undefined);
    });
    stage.show(selector);
  });
}

/** A login step's question, asked in the dialog, or in a list or a masked line over it. */
async function answer(stage: Stage, dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
  // pi's dialog shows what is typed, and then what was entered, so a secret is entered in a line of its own.
  const response = prompt.type === "secret"
    ? new Promise<string>((resolve, reject) => {
      stage.show(new SecretEntry(prompt.message, (secret) => {
        stage.show(dialog);
        if (secret === undefined) reject(new Error("Login cancelled"));
        else resolve(secret);
      }));
    })
    : prompt.type === "select"
    ? new Promise<string>((resolve, reject) => {
      const back = () => stage.show(dialog);
      const selector = new ExtensionSelectorComponent(prompt.message, prompt.options.map((option) => option.label), (label) => {
        back();
        const id = prompt.options.find((option) => option.label === label)?.id;
        if (id === undefined) reject(new Error("Login cancelled"));
        else resolve(id);
      }, () => {
        back();
        reject(new Error("Login cancelled"));
      });
      stage.show(selector);
    })
    : prompt.type === "manual_code" ? dialog.showManualInput(prompt.message) : dialog.showPrompt(prompt.message, prompt.placeholder);
  // A question the flow no longer needs, such as a code the browser already delivered, ends the wait.
  return prompt.signal === undefined ? response : unlessCancelled(response, prompt.signal);
}

/** What `step` comes to, unless `signal` cancels the login first. */
function unlessCancelled<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("Login cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    void step.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** A sign-in step's news, made printable first, as it comes from the provider. */
function tell(dialog: LoginDialogComponent, news: AuthEvent): void {
  const event = deepPrintable(news);
  if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
  else if (event.type === "device_code") {
    dialog.showDeviceCode(event);
    dialog.showWaiting("Waiting for authentication...");
  } else if (event.type === "info") dialog.showInfo(event.message, event.links);
  else dialog.showProgress(event.message);
}

/** One line entered as dots, such as a key, which no screen or scrollback should keep. */
class SecretEntry implements Component, Focusable {
  focused = false;
  readonly #message: string;
  readonly #done: (secret: string | undefined) => void;
  #value = "";

  constructor(message: string, done: (secret: string | undefined) => void) {
    this.#message = message;
    this.#done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) this.#done(this.#value.trim());
    else if (matchesKey(data, "escape")) this.#done(undefined);
    else if (matchesKey(data, "backspace")) this.#value = this.#value.slice(0, -1);
    else this.#value += typed(data);
  }

  render(width: number): string[] {
    return [
      "",
      truncateToWidth(` ${oneRow(this.#message)}`, width),
      truncateToWidth(` > ${"•".repeat(this.#value.length)}`, width),
      truncateToWidth(style("dim")(" enter submits, esc cancels"), width),
    ];
  }

  invalidate(): void {}
}

/** The text a key press or a paste puts in, without the markers a paste comes wrapped in; nothing for other keys. */
function typed(data: string): string {
  const text = data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+/g, "");
  return /[\x00-\x1f\x7f]/.test(text) ? "" : text;
}
