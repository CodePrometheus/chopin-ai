import type { Ctx, Host } from "@earendil-works/chord";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Container, Editor, Loader, matchesKey, ProcessTerminal, Text, truncateToWidth, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { Command } from "@chopin-ai/core";
import { isRunning } from "@chopin-ai/harness-pi";
import {
  call,
  connect,
  endText,
  errorText,
  heldList,
  lastFailure,
  MODES,
  resender,
  startConversation,
  type CallOptions,
  type ConversationRef,
} from "@chopin-ai/harness-pi/protocol";
import { Asker, Declined } from "./ask.js";
import { chopinCredentials, chopinModels } from "./credentials.js";
import { readSettings, writeSettings } from "./home.js";
import { pickInTerminal, type ModelRef } from "./model.js";
import { chooseModel, signIn } from "./sign-in.js";
import { findProject, openProject } from "./project.js";
import { editorTheme, style } from "./theme.js";
import { oneRow, printable, Transcript } from "./transcript.js";

const STARTING = "a conversation is starting";
const HELP = `/new starts a conversation, /model picks its model, /login connects a provider, /logout, /mode ${MODES.join("|")} sets what it may do, // sends a line that starts with /, esc stops the agent, ctrl+c quits`;

export interface ChatOptions extends CallOptions {
  /** The models this terminal signs in to and picks from; without them, /login, /logout and /model are refused. */
  models?: Models;
  /** Where sign-ins are kept, to list them for /logout. */
  credentials?: CredentialStore;
}

/** A conversation with the agent of the project in the current directory, in the terminal. */
export const chatCommand: Command = {
  name: "chat",
  args: "",
  summary: "talk to this project's agent in the terminal; a bare chopin does the same",
  run: async (args, io) => {
    if (args.length > 0) {
      io.err("usage: chopin chat");
      return 2;
    }
    const project = await openProject(process.cwd(), pickInTerminal);
    const host = connect(project.url, { token: project.token, find: findProject(process.cwd()) });
    const credentials = chopinCredentials();
    try {
      await chat(host, new ProcessTerminal(), { models: chopinModels(credentials), credentials });
    } finally {
      await host.close();
    }
    return 0;
  },
};

/** Runs the conversation on `terminal` until the user quits; `options` bound every call to the service. */
export async function chat(host: Host, terminal: Terminal, options: ChatOptions = {}): Promise<void> {
  const list = heldList(host, options);
  const tui = new TuiMainScreen(terminal);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const status = new StatusLine();
  const body = new Container();
  /** Where questions such as /login's are asked, between the conversation and the editor. */
  const questions = new Container();
  const errors = new Container();
  const working = new Container();
  let asking = false;
  /** What the last action did, shown until the next. */
  let note: string | undefined;
  let transcript = new Transcript();
  let conversation: ConversationRef | undefined;
  let stops: (() => void)[] = [];
  let failure: string | undefined;
  let closed = false;
  let send = resender();
  // A `/new` while one is under way joins it instead of leaving an empty conversation behind.
  let starting: Promise<void> | undefined;
  /** How many conversations the terminal has left; what an action on one of them comes to is no longer shown. */
  let left = 0;
  const ask = <T>(work: (ctx: Ctx) => Promise<T>) => call(host, work, options);

  /** The conversation messages go to, which a reconnect still reaches, or why there is none. */
  const target = (): ConversationRef | string => {
    if (starting !== undefined) return STARTING;
    if (conversation === undefined) return "no conversation; /new starts one";
    if (conversation.status === "live" || conversation.status === "loading") return conversation;
    return `the conversation ended (${endText(conversation)}); /new starts another`;
  };

  /** What went wrong, as the last thing in the conversation: what an action came to, or why the agent did not answer. */
  let shownErrors = "";
  const showErrors = (texts: readonly (string | undefined)[]) => {
    const unique = [...new Set(texts.filter((text): text is string => text !== undefined))];
    if (unique.join("\n") === shownErrors) return;
    shownErrors = unique.join("\n");
    errors.clear();
    for (const text of unique) errors.addChild(new Text(style("red")(`Error: ${printable(text)}`), 1, 1));
  };
  /** A spinner while the agent works, between the conversation and the editor. */
  let spinner: Loader | undefined;
  const showWorking = (busy: boolean) => {
    if (busy && spinner === undefined) {
      spinner = new Loader(tui, style("cyan"), style("dim"), "Working… esc stops it");
      working.addChild(spinner);
    } else if (!busy && spinner !== undefined) {
      spinner.stop();
      spinner = undefined;
      working.clear();
    }
  };

  const render = () => {
    if (closed) return;
    const current = target();
    const live = typeof current !== "string" && current.status === "live" ? current : undefined;
    const view = live?.view.value as ConversationView | undefined;
    if (view !== undefined) transcript.update(view);
    const busy = view !== undefined && isRunning(view);
    showWorking(busy);
    showErrors([failure, live === undefined || busy ? undefined : lastFailure(live.submissions.value)]);
    if (live === undefined || view === undefined) {
      const why = typeof current === "string" ? current : "reconnecting…";
      status.set(starting !== undefined ? "dim" : "red", `${why}${starting !== undefined ? "…" : ""} · ${HELP}`);
    } else {
      const model = (view.docs["pi.agent"]?.model as { modelId?: string } | undefined)?.modelId ?? "model";
      status.set("dim", `${model} · ${live.mode.value} · ${busy ? "working" : note ?? "ready"} · ${HELP}`);
    }
    tui.requestRender();
  };
  /** Stops following the conversation and lets it go; the agent carries on with whatever it was doing. */
  const leave = () => {
    left++;
    stops.forEach((stop) => stop());
    stops = [];
    conversation?.release();
    conversation = undefined;
    body.clear();
  };
  // `/new` leaves the conversation at once, so nothing typed or stopped meanwhile reaches the one left.
  const startNew = async () => {
    leave();
    const { conversation: next } = await startConversation(host, list.get, options);
    if (closed) {
      next.release();
      return;
    }
    // A refusal for its starting is moot once it has; any other word stays.
    if (failure === STARTING) failure = undefined;
    conversation = next;
    send = resender();
    transcript = new Transcript();
    body.addChild(transcript);
    stops = [
      next.view.subscribe(render), next.mode.subscribe(render), next.submissions.subscribe(render), next.onStatus(render),
    ];
  };
  const begin = () => {
    starting ??= startNew().finally(() => {
      starting = undefined;
      render();
    });
    render();
    return starting;
  };

  const done = Promise.withResolvers<void>();
  // An action that fails is shown on the status line until the next one, and a message it could not send goes back
  // into an empty editor; the conversation goes on.
  const act = (work: () => Promise<unknown>, unsent?: string) => {
    failure = undefined;
    note = undefined;
    render();
    const running = work();
    // Taken after `work` starts, since `/new` leaves the conversation as it does.
    const at = left;
    void running.catch((error: unknown) => {
      // Of an action on a conversation since left, only a message is told, given back rather than lost.
      if (at !== left && unsent === undefined) return;
      failure = at === left ? errorText(error) : `the message to the conversation left may not have reached it (${errorText(error)})`;
      if (unsent !== undefined && editor.getText() === "") editor.setText(unsent);
      render();
    });
  };
  const refuse = (why: string, unsent: string) => act(async () => { throw new Error(why); }, unsent);
  /** Puts questions to the user in place of the editor until `work` is over; one turned down ends it quietly. */
  const withQuestions = async (work: (asker: Asker, models: Models) => Promise<string | undefined>) => {
    if (options.models === undefined) throw new Error("this terminal cannot sign in or pick models");
    asking = true;
    const asker = new Asker(tui, questions, () => tui.setFocus(editor));
    try {
      note = await work(asker, options.models);
    } catch (error) {
      if (!(error instanceof Declined)) throw error;
    } finally {
      asking = false;
      asker.close();
      render();
    }
  };
  /** New conversations start with `model`, and so does the one here from its next turn. */
  const useModel = async (model: ModelRef): Promise<string> => {
    await writeSettings({ ...(await readSettings()), model: `${model.provider}/${model.modelId}` });
    const current = target();
    if (typeof current !== "string") await ask((ctx) => current.setModel(model, ctx));
    return `now on ${model.modelId}`;
  };
  /** The model the conversation here runs with, and the one new conversations start with. */
  const models = async (): Promise<{ inUse?: ModelRef; preset?: ModelRef }> => {
    const current = target();
    const view = typeof current === "string" || current.status !== "live" ? undefined : current.view.value as ConversationView;
    const inUse = view?.docs["pi.agent"]?.model as ModelRef | undefined;
    const [provider, ...rest] = (await readSettings()).model?.split("/") ?? [];
    return { ...(inUse && { inUse }), ...(provider !== undefined && rest.length > 0 && { preset: { provider, modelId: rest.join("/") } }) };
  };
  const commands: Readonly<Record<string, (rest: readonly string[]) => (() => Promise<unknown>) | string>> = {
    "/model": (rest) => rest.length > 0 ? "usage: /model" : () => withQuestions(async (asker, all) => {
      const { inUse, preset } = await models();
      return useModel(await chooseModel(all, asker, inUse, preset));
    }),
    "/login": (rest) => rest.length > 1 ? "usage: /login [provider]" : () => withQuestions(async (asker, all) => {
      const id = await signIn(all, asker, rest[0]);
      return `connected ${all.getProvider(id)?.name ?? id}; /model picks one of its models`;
    }),
    "/logout": (rest) => rest.length > 1 ? "usage: /logout [provider]" : () => withQuestions(async (asker, models) => {
      const stored = await options.credentials?.list() ?? [];
      if (stored.length === 0) throw new Error("nothing is signed in here; a key in an environment variable stays until it is unset");
      const name = (id: string) => models.getProvider(id)?.name ?? id;
      const id = rest[0] ?? await asker.choose("Sign out of", stored.map((entry) => ({ value: entry.providerId, label: name(entry.providerId) })));
      await models.logout(id);
      return `signed out of ${name(id)}`;
    }),
  };
  // A line starting with "/" is a command, never a message: a mistyped one would cost a turn the user did not mean.
  editor.onSubmit = (submitted) => {
    const text = submitted.trim();
    if (text === "") return;
    // A conversation that is reconnecting still takes a message; the call waits for it, within bounds.
    const current = target();
    if (text.startsWith("/") && !text.startsWith("//")) {
      const [word, ...rest] = text.split(/\s+/);
      const mode = MODES.find((known) => rest.length === 1 && rest[0] === known);
      const command = word === undefined ? undefined : commands[word]?.(rest);
      if (typeof command === "function") act(command);
      else if (typeof command === "string") refuse(command, submitted);
      else if (word === "/new" && rest.length === 0) act(begin);
      else if (word === "/new") refuse("usage: /new", submitted);
      else if (word !== "/mode") refuse(`unknown command ${word}: ${HELP}`, submitted);
      else if (mode === undefined) refuse(`usage: /mode ${MODES.join("|")}`, submitted);
      else if (typeof current === "string") refuse(current, submitted);
      else act(() => ask((ctx) => current.setMode({ mode }, ctx)));
      return;
    }
    const message = text.startsWith("//") ? text.slice(1) : text;
    if (typeof current === "string") refuse(current, submitted);
    else act(() => send(message, (request) => ask((ctx) => current.submit({ text: message, request }, ctx))), submitted);
  };
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      done.resolve();
      return { consume: true };
    }
    // While a question is open, escape answers it.
    if (asking) return undefined;
    const current = target();
    const running = typeof current !== "string" && current.status === "live" && isRunning(current.view.value as ConversationView);
    if (matchesKey(data, "escape") && running) {
      act(() => ask((ctx) => current.abort({}, ctx)));
      return { consume: true };
    }
    return undefined;
  });

  tui.addChild(body);
  tui.addChild(errors);
  tui.addChild(working);
  tui.addChild(questions);
  tui.addChild(editor);
  tui.addChild(status);
  tui.setFocus(editor);
  tui.start();
  // A first conversation that cannot be started yet is no reason to quit: the failure shows, and /new tries again.
  act(begin);
  await done.promise;
  closed = true;
  showWorking(false);
  tui.stop();
  leave();
  list.release();
}

/** One line under the editor, cut to the terminal's width: whatever it is given is made printable and kept to one row. */
class StatusLine implements Component {
  #text = "";

  set(tone: "dim" | "red", text: string): void {
    this.#text = style(tone)(oneRow(text));
  }

  render(width: number): string[] {
    return [truncateToWidth(` ${this.#text}`, width)];
  }

  invalidate(): void {}
}
