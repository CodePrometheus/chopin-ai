import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Ctx, Host } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  copyToClipboard,
  initTheme,
  resolveModelScopeWithDiagnostics,
  type ModelRuntime,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { UserEntry, type ConversationView } from "@earendil-works/pi-durable";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  type KeyId,
  type TUI,
  type SlashCommand,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { Command } from "@chopin-ai/core";
import { compactionFailure, isCompacting, isRunning, userText } from "@chopin-ai/harness-pi";
import {
  call,
  connect,
  endText,
  errorText,
  heldList,
  lastFailure,
  MODES,
  openConversation,
  resender,
  startConversation,
  type CallOptions,
  type ConversationRef,
  type Running,
} from "@chopin-ai/harness-pi/protocol";
import { stageIn } from "./ask.js";
import { editSettings, forkChoices, pickConversation, pickMessage, pickThinking } from "./dialogs.js";
import { editElsewhere } from "./external-editor.js";
import { Footer, usageText, whereText } from "./footer.js";
import { chopinModels } from "./credentials.js";
import { Header } from "./header.js";
import { changeSettings, layerDirectory, readSettings, type Settings } from "./home.js";
import { defaultModel, pickInTerminal, type ModelRef } from "./model.js";
import { clipboardPaste, insertApart, shellWord } from "./paste.js";
import { pickModel, signIn, signOut } from "./sign-in.js";
import { findProject, openProject } from "./project.js";
import { editorTheme, style } from "./theme.js";
import { printable, Transcript } from "./transcript.js";

const STARTING = "a conversation is starting";
const HELP = `/new, /resume, /fork, /model, /thinking, /name, /compact, /login, /logout, /mode ${MODES.join("|")}, /settings, /copy, /export, /session, /hotkeys`;

/** The keys, as /hotkeys lists them: pi's own. */
const HOTKEYS = [
  ["enter", "send; while the agent works, steer it"],
  ["alt+enter", "queue a message for after the agent's work"],
  ["alt+up", "edit all queued messages"],
  ["esc", "stop the agent, taking its queued messages back, or else the command running"],
  ["!", "run a command in the workspace; the model sees what it prints"],
  ["!!", "run a command the model does not see"],
  ["ctrl+o", "expand or collapse tool output"],
  ["ctrl+t", "show or hide thinking"],
  ["ctrl+l", "pick a model"],
  ["ctrl+p", "the next model; shift+ctrl+p the one before"],
  ["shift+tab", "the next thinking level"],
  ["ctrl+g", "write the message in $VISUAL or $EDITOR"],
  ["ctrl+v", "paste files, an image, or text"],
  ["ctrl+z", "suspend to the background"],
  ["ctrl+d", "quit, when the editor is empty"],
  ["ctrl+c", "quit"],
  ["tab", "complete a command, or a path after @"],
] as const;

/** The commands, as the editor offers them while one is typed. */
const COMMANDS: readonly SlashCommand[] = [
  { name: "new", description: "start a conversation" },
  { name: "model", description: "pick the model this conversation and new ones run with" },
  { name: "login", description: "connect a provider", argumentHint: "[provider]" },
  { name: "logout", description: "disconnect a provider", argumentHint: "[provider]" },
  { name: "resume", description: "go back to another conversation" },
  { name: "fork", description: "start over from an earlier message, in a new conversation" },
  { name: "thinking", description: "set how much the model thinks", argumentHint: "[level]" },
  { name: "name", description: "name this conversation, or show its name", argumentHint: "[name]" },
  { name: "compact", description: "summarize the conversation so far", argumentHint: "[instructions]" },
  { name: "copy", description: "copy the last answer" },
  { name: "export", description: "write this conversation to a file as ACP lines", argumentHint: "[path]" },
  { name: "settings", description: "change the theme, and whether thinking shows" },
  { name: "session", description: "show this conversation and what it has used" },
  { name: "hotkeys", description: "list the keys" },
  {
    name: "mode", description: "set what the agent may do", argumentHint: MODES.join("|"),
    getArgumentCompletions: (prefix) => MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode })),
  },
];

export interface ChatOptions extends CallOptions {
  /** The models this terminal signs in to and picks from; without them, /login, /logout and /model are refused. */
  models?: ModelRuntime;
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
    try {
      await chat(host, new ProcessTerminal(), { models: await chopinModels() });
    } finally {
      await host.close();
    }
    return 0;
  },
};

/** Runs the conversation on `terminal` until the user quits; `options` bound every call to the service. */
export async function chat(host: Host, terminal: Terminal, options: ChatOptions = {}): Promise<void> {
  const settings = await readSettings();
  initTheme(settings.theme);
  const list = heldList(host, options);
  const tui = new TuiMainScreen(terminal);
  // Commands and the project's files complete as they are typed.
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...COMMANDS], process.cwd()));
  // A line starting with "!" is a command for the workspace, and the editor's border says so, as pi has it.
  editor.onChange = (text) => {
    editor.borderColor = text.trimStart().startsWith("!") ? style("green") : editorTheme.borderColor;
  };
  let expanded = false;
  let hideThinking = settings.hideThinking ?? false;
  const header = new Header(await version(), HOTKEYS, join(layerDirectory(), "AGENTS.md"));
  const footer = new Footer();
  const branchName = await branch(process.cwd());
  footer.setWhere(whereText(process.cwd(), branchName));
  const body = new Container();
  /** The editor's place, where dialogs such as /login's show in its stead. */
  const editorSlot = new Container();
  const stage = stageIn(tui, editorSlot, editor);
  const errors = new Container();
  /** What a command such as /session shows, after the conversation, until the next action. */
  const notes = new Container();
  const showNotes = (lines: readonly string[]) => {
    notes.clear();
    if (lines.length > 0) notes.addChild(new Text(style("dim")(printable(lines.join("\n"))), 1, 1));
  };
  const working = new Container();
  let asking = false;
  /** What the last action did, shown until the next. */
  let note: string | undefined;
  let transcript = new Transcript(tui);
  let conversation: ConversationRef | undefined;
  let stops: (() => void)[] = [];
  let failure: string | undefined;
  let closed = false;
  let send = resender();
  // A `/new` while one is under way joins it instead of leaving an empty conversation behind.
  let starting: Promise<boolean> | undefined;
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
  /** A spinner saying what is under way, between the conversation and the editor. */
  let spinner: Loader | undefined;
  const showWorking = (what: string | undefined) => {
    if (what !== undefined && spinner === undefined) {
      spinner = new Loader(tui, style("cyan"), style("dim"), what);
      working.addChild(spinner);
    } else if (what !== undefined) {
      spinner?.setMessage(what);
    } else if (spinner !== undefined) {
      spinner.stop();
      spinner = undefined;
      working.clear();
    }
  };
  /** The compaction failure last told, so each is told once. */
  let toldCompaction: number | undefined;
  /** The conversation last shown: its messages are in the editor's history, as pi recalls them with up. */
  let recalled: ConversationRef | undefined;

  const render = () => {
    if (closed) return;
    const here = live();
    const view = typeof here === "string" ? undefined : here.view;
    if (view !== undefined) transcript.update(view);
    if (typeof here !== "string") {
      transcript.setRunning(here.conversation.running.value as Running);
      if (recalled !== here.conversation) {
        recalled = here.conversation;
        toldCompaction = compactionFailure(here.view)?.taskId;
        for (const entry of here.view.entries) if (entry.kind === UserEntry.kind) for (const message of entry.model ?? []) if (message.role === "user") editor.addToHistory(userText(message.content));
      }
    }
    const busy = view !== undefined && isRunning(view);
    const compacting = view !== undefined && isCompacting(view);
    showWorking(busy ? "Working… esc stops it" : compacting ? "Compacting…" : undefined);
    const compaction = view === undefined ? undefined : compactionFailure(view);
    if (compaction !== undefined && compaction.taskId !== toldCompaction) {
      toldCompaction = compaction.taskId;
      failure = `compaction failed: ${compaction.error}`;
    }
    if (typeof here === "string") {
      showErrors([failure]);
      footer.set(starting !== undefined ? "dim" : "red", `${here}${starting !== undefined ? "…" : ""}`);
    } else {
      showErrors([failure, busy ? undefined : lastFailure(here.conversation.submissions.value)]);
      const thinking = thinkingOf(here.view);
      footer.setWhere(whereText(process.cwd(), branchName, here.conversation.name.value));
      // What is under way comes first, then what the last action did.
      const doing = busy ? "working" : compacting ? "compacting" : here.conversation.running.value !== null ? "running a command" : undefined;
      footer.set("dim", [doing ?? note ?? "ready", doing && note, usedBy(here.view)].filter((part) => part !== undefined && part !== "").join(" · "),
        `${modelOf(here.view)?.modelId ?? "no model"}${thinking === "off" ? "" : ` • ${thinking}`} · ${here.conversation.mode.value}`);
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
    transcript.dispose();
    body.clear();
  };
  /** A new conversation in the owner's list, opened. */
  const fresh = async () => (await startConversation(host, list.get, options)).conversation;
  // Moving leaves the conversation at once, so nothing typed or stopped meanwhile reaches the one left.
  const moveTo = async (open: () => Promise<ConversationRef>, draft?: string) => {
    leave();
    const next = await open();
    if (closed) {
      next.release();
      return;
    }
    // A refusal for its starting is moot once it has; any other word stays.
    if (failure === STARTING) failure = undefined;
    conversation = next;
    send = resender();
    transcript = new Transcript(tui);
    transcript.setExpanded(expanded);
    transcript.setHideThinking(hideThinking);
    body.addChild(transcript);
    stops = [
      next.view.subscribe(render), next.mode.subscribe(render), next.name.subscribe(render), next.submissions.subscribe(render),
      next.running.subscribe(render), next.onStatus(render),
    ];
    if (draft !== undefined) editor.setText(draft);
  };
  /**
   * Moves to the conversation `open` gives, or a new one, resolving whether it did; a move that fails says why, as an
   * action on the conversation it was going to. A new one joins a move under way, a chosen one is refused meanwhile.
   */
  const begin = (open?: () => Promise<ConversationRef>, draft?: string): Promise<boolean> => {
    if (starting !== undefined && open !== undefined) return Promise.reject(new Error(STARTING));
    starting ??= moveTo(open ?? fresh, draft).then(() => true, (error: unknown) => {
      failure = errorText(error);
      return false;
    }).finally(() => {
      starting = undefined;
      render();
    });
    render();
    return starting;
  };

  const done = Promise.withResolvers<void>();
  /** Aborted as the terminal quits, so what a dialog left running, such as a sign-in's server, ends with it. */
  const quitting = new AbortController();
  // An action that fails is shown on the status line until the next one, and a message it could not send goes back
  // into an empty editor; the conversation goes on.
  const act = (work: () => Promise<unknown>, unsent?: string) => {
    failure = undefined;
    note = undefined;
    showNotes([]);
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
  /** Shows dialogs in place of the editor until `work` is over; what it says becomes the note on the status line. */
  const withDialogs = async (work: () => Promise<string | undefined>) => {
    asking = true;
    try {
      note = await work();
    } finally {
      asking = false;
      stage.restore();
      render();
    }
  };
  const models = () => {
    if (options.models === undefined) throw new Error("this terminal cannot sign in or pick models");
    return options.models;
  };
  /** Keeps `change` in the settings; one that cannot be kept is told as the action's failure. */
  const remember = (change: Partial<Settings>) => void changeSettings(change).catch((error: unknown) => {
    failure = errorText(error);
    render();
  });
  /** The models ctrl+p goes through, as pi has them: those enabledModels names that can be used, else all that can. */
  const cycled = async (runtime: ModelRuntime): Promise<{ models: readonly ScopedModel[]; scoped: boolean }> => {
    const patterns = (await readSettings()).enabledModels ?? [];
    const usable = runtime.getAvailableSnapshot();
    if (patterns.length === 0) return { models: usable.map((model) => ({ model })), scoped: false };
    const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, runtime);
    showNotes(diagnostics.map((diagnostic) => diagnostic.message));
    const ids = new Set(usable.map((model) => `${model.provider}/${model.id}`));
    return { models: scopedModels.filter(({ model }) => ids.has(`${model.provider}/${model.id}`)), scoped: true };
  };
  /** Moves the conversation here to the next model ctrl+p goes through, or the one before; new ones keep their default. */
  const cycleModel = (step: 1 | -1) => act(async () => {
    const { conversation: current, view } = here();
    const { models: choices, scoped } = await cycled(models());
    if (choices.length <= 1) return say(scoped ? "only one model in scope" : "only one model available");
    const now = modelOf(view);
    const at = Math.max(0, choices.findIndex(({ model }) => model.provider === now?.provider && model.id === now.modelId));
    const next = choices[(at + step + choices.length) % choices.length]!;
    await ask((ctx) => current.setModel({ provider: next.model.provider, modelId: next.model.id }, ctx));
    if (next.thinkingLevel !== undefined) await setThinking(next.thinkingLevel);
    const thinking = next.model.reasoning && next.thinkingLevel !== undefined && next.thinkingLevel !== "off" ? ` (thinking: ${next.thinkingLevel})` : "";
    say(`switched to ${next.model.name || next.model.id}${thinking}`);
  });
  /** New conversations start with `model`, and so does the one here from its next turn. */
  const useModel = async (model: ModelRef): Promise<string> => {
    await changeSettings({ model: `${model.provider}/${model.modelId}` });
    const current = target();
    if (typeof current !== "string") await ask((ctx) => current.setModel(model, ctx));
    return `now on ${model.modelId}`;
  };
  /** The conversation here with its view while it is live; otherwise why not. */
  const live = (): { conversation: ConversationRef; view: ConversationView } | string => {
    const current = target();
    if (typeof current === "string") return current;
    return current.status === "live" ? { conversation: current, view: current.view.value as ConversationView } : "the conversation is reconnecting";
  };
  /** The conversation here with its view, for a command that needs it; otherwise why not, as the error. */
  const here = () => {
    const found = live();
    if (typeof found === "string") throw new Error(found);
    return found;
  };
  const viewHere = () => {
    const found = live();
    return typeof found === "string" ? undefined : found.view;
  };
  /** What the conversation's answers used, against its model's context window. */
  const usedBy = (view: ConversationView) => {
    const model = modelOf(view);
    return usageText(view, catalogued(view)?.contextWindow, model !== undefined && options.models?.isUsingSubscription(model.provider) === true);
  };
  /** The model the conversation runs with, as the catalog has it. */
  const catalogued = (view: ConversationView) => {
    const model = modelOf(view);
    return model === undefined ? undefined : options.models?.getModel(model.provider, model.modelId);
  };
  /** The thinking levels the conversation's model has. */
  const levelsOf = (view: ConversationView): readonly string[] => {
    const model = catalogued(view);
    return model === undefined ? ["off"] : getSupportedThinkingLevels(model);
  };
  const setThinking = async (level: string) => {
    const { conversation: current } = here();
    await ask((ctx) => current.setThinking({ level }, ctx));
    return `thinking ${level}`;
  };
  const say = (text: string) => {
    note = text;
    render();
  };
  const inUse = () => {
    const view = viewHere();
    return view && modelOf(view);
  };
  const named = (runtime: ModelRuntime, id: string) => runtime.getProvider(id)?.name ?? id;
  const pickAndUse = async () => {
    const runtime = models();
    const picked = await pickModel(stage, runtime, inUse(), await defaultModel(), (await cycled(runtime)).models);
    return picked && useModel(picked);
  };
  const commands: Readonly<Record<string, (rest: readonly string[]) => (() => Promise<unknown>) | string>> = {
    "/model": (rest) => rest.length > 0 ? "usage: /model" : () => withDialogs(pickAndUse),
    "/login": (rest) => rest.length > 1 ? "usage: /login [provider]" : () => withDialogs(async () => {
      const runtime = models();
      const id = await signIn(stage, runtime, rest[0], quitting.signal);
      return id && `connected ${named(runtime, id)}; /model picks one of its models`;
    }),
    "/logout": (rest) => rest.length > 1 ? "usage: /logout [provider]" : () => withDialogs(async () => {
      const runtime = models();
      const id = await signOut(stage, runtime, rest[0]);
      return id && `signed out of ${named(runtime, id)}`;
    }),
    "/hotkeys": (rest) => rest.length > 0 ? "usage: /hotkeys" : async () => {
      const width = Math.max(...HOTKEYS.map(([key]) => key.length));
      showNotes(HOTKEYS.map(([key, what]) => `${key.padEnd(width)}  ${what}`));
    },
    "/session": (rest) => rest.length > 0 ? "usage: /session" : async () => {
      const { conversation: current, view } = here();
      const model = modelOf(view);
      const used = usedBy(view);
      showNotes([
        `conversation ${view.conversation.id} · ${model === undefined ? "no model" : `${model.provider}/${model.modelId}`} · ${current.mode.value}`,
        `${view.entries.length} entries in context${used === "" ? "" : ` · ${used}`}`,
      ]);
    },
    "/copy": (rest) => rest.length > 0 ? "usage: /copy" : async () => {
      const answer = here().view.entries.flatMap((entry) => entry.model ?? [])
        .findLast((message): message is AssistantMessage => message.role === "assistant");
      const text = answer?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ?? "";
      if (text === "") throw new Error("there is no answer to copy yet");
      await copyToClipboard(text);
      say("copied the last answer");
    },
    "/thinking": (rest) => rest.length > 1 ? "usage: /thinking [level]" : async () => {
      if (rest[0] !== undefined) return say(await setThinking(rest[0]));
      return withDialogs(async () => {
        const { view } = here();
        const picked = await pickThinking(stage, thinkingOf(view), levelsOf(view));
        return picked && setThinking(picked);
      });
    },
    "/name": (rest) => async () => {
      const { conversation: current } = here();
      if (rest.length === 0) return say(current.name.value === "" ? "this conversation has no name; /name <name> gives it one" : `named ${current.name.value}`);
      const name = rest.join(" ");
      await ask((ctx) => current.setName({ name }, ctx));
      say(`named ${name}`);
    },
    "/compact": (rest) => async () => {
      const { conversation: current } = here();
      await ask((ctx) => current.compact(rest.length === 0 ? {} : { instructions: rest.join(" ") }, ctx));
    },
    "/fork": (rest) => rest.length > 0 ? "usage: /fork" : () => withDialogs(async () => {
      const { view } = here();
      const messages = forkChoices(view);
      if (messages.length === 0) throw new Error("there is no message to fork from yet");
      const pickedId = await pickMessage(stage, messages);
      const picked = messages.find((message) => message.id === pickedId);
      if (picked === undefined) return undefined;
      const from = Number(view.conversation.id);
      const { at } = picked;
      // The message picked waits in the editor, to be sent again in the fork, changed or not.
      const fork = at === undefined ? undefined : await ask(async (ctx) => (await list.get()).fork({ conversation: from, at }, ctx));
      if (!(await begin(fork === undefined ? fresh : () => openConversation(host, fork, options), picked.text))) return undefined;
      return `forked conversation ${from}; the message is back in the editor`;
    }),
    "/resume": (rest) => rest.length > 0 ? "usage: /resume" : () => withDialogs(async () => {
      const id = viewHere()?.conversation.id;
      const current = id === undefined ? undefined : Number(id);
      const picked = await pickConversation(stage, process.cwd(), () => ask(async (ctx) => (await list.get()).summaries(ctx)), current);
      if (picked === undefined || picked === current) return undefined;
      if (!(await begin(() => openConversation(host, picked, options)))) return undefined;
      return `resumed conversation ${picked}`;
    }),
    "/settings": (rest) => rest.length > 0 ? "usage: /settings" : () => withDialogs(async () => {
      const drawWith = (theme: string) => {
        initTheme(theme);
        tui.invalidate();
        tui.requestRender();
      };
      await editSettings(stage, {
        theme: (await readSettings()).theme ?? "system",
        hideThinking,
        drawWith,
        setTheme: (theme) => {
          drawWith(theme);
          remember({ theme });
        },
        setHideThinking: (hidden) => {
          transcript.setHideThinking((hideThinking = hidden));
          remember({ hideThinking });
        },
      });
      return undefined;
    }),
    "/export": (rest) => rest.length > 1 ? "usage: /export [path]" : async () => {
      const { conversation: current, view } = here();
      const file = resolve(rest[0] ?? `chopin-${view.conversation.id}.jsonl`);
      const lines = await ask((ctx) => current.transcript({}, ctx));
      // Readable by its owner alone, as the conversation may hold anything its tools read.
      await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
      say(`exported to ${file}`);
    },
  };
  /**
   * What the user sent: a line starting with "/" is a command, never a message, as a mistyped one would cost a turn
   * the user did not mean, and one starting with "!" runs in the workspace. A message steers the agent at work, as pi
   * has it, unless it is `queued` for after.
   */
  const submit = (submitted: string, queued: boolean) => {
    const text = submitted.trim();
    if (text === "") return;
    editor.addToHistory(text);
    // A conversation that is reconnecting still takes a message; the call waits for it, within bounds.
    const current = target();
    // "!" runs a command in the workspace, whose output the model then sees; "!!" one it does not.
    const excluded = text.startsWith("!!");
    const command = text.startsWith("!") ? text.slice(excluded ? 2 : 1).trim() : "";
    if (command !== "") {
      if (typeof current === "string") refuse(current, submitted);
      else act(() => call(host, (ctx) => current.shell({ command, ...(excluded && { excluded }) }, ctx), { ...options, timeoutMs: Infinity }), submitted);
      return;
    }
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
    const steer = !queued && agentAtWork();
    if (typeof current === "string") refuse(current, submitted);
    else act(() => send(message, (request) => ask((ctx) => current.submit({ text: message, request, ...(steer && { steer }) }, ctx))), submitted);
  };
  editor.onSubmit = (submitted) => submit(submitted, false);
  const agentAtWork = () => {
    const view = viewHere();
    return view !== undefined && isRunning(view);
  };
  /** Takes the messages queued for `current` back into the editor, ahead of what it holds; resolves how many. */
  const takeBackQueued = async (current: ConversationRef) => {
    const texts = await ask((ctx) => current.withdraw({}, ctx));
    if (texts.length > 0) editor.setText([...texts, editor.getText()].filter((text) => text.trim() !== "").join("\n\n"));
    return texts.length;
  };
  /** pi's keys for its app actions, on pi's default keys; a handler answering false passes its key on to the editor. */
  const keys: readonly [KeyId, () => false | void][] = [
    ["alt+enter", () => {
      const submitted = editor.getText();
      if (submitted.trim() === "") return;
      editor.setText("");
      submit(submitted, true);
    }],
    ["ctrl+o", () => {
      expanded = !expanded;
      transcript.setExpanded(expanded);
      header.setExpanded(expanded);
    }],
    ["ctrl+t", () => {
      transcript.setHideThinking((hideThinking = !hideThinking));
      remember({ hideThinking });
      say(`thinking blocks: ${hideThinking ? "hidden" : "visible"}`);
    }],
    ["ctrl+l", () => act(() => withDialogs(pickAndUse))],
    ["ctrl+p", () => cycleModel(1)],
    ["shift+ctrl+p", () => cycleModel(-1)],
    ["alt+up", () => act(async () => {
      const restored = await takeBackQueued(here().conversation);
      say(restored === 0 ? "no queued messages to restore" : `restored ${restored} queued message${restored > 1 ? "s" : ""} to the editor`);
    })],
    ["ctrl+v", () => act(async () => {
      const pasted = await clipboardPaste();
      if (typeof pasted === "string") editor.insertTextAtCursor(pasted);
      else if (pasted !== undefined) insertApart(editor, editor.getText().trimStart().startsWith("!") ? pasted.map(shellWord).join(" ") : pasted.join("\n"));
    })],
    ["ctrl+d", () => {
      if (editor.getText() !== "") return false;
      done.resolve();
    }],
    ["ctrl+g", () => act(async () => {
      tui.stop();
      try {
        const edited = await editElsewhere(editor.getText());
        if (edited !== undefined) editor.setText(edited);
      } finally {
        tui.start();
        tui.requestRender(true);
      }
    })],
    ["ctrl+z", () => suspend(tui)],
    ["shift+tab", () => act(async () => {
      const { view } = here();
      const levels = levelsOf(view);
      say(await setThinking(levels[(levels.indexOf(thinkingOf(view)) + 1) % levels.length] ?? "off"));
    })],
  ];
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      done.resolve();
      return { consume: true };
    }
    // While a dialog is open, its keys are its own.
    if (asking) return undefined;
    const key = keys.find(([id]) => matchesKey(data, id));
    if (key !== undefined && key[1]() !== false) {
      tui.requestRender();
      return { consume: true };
    }
    // As pi has it, esc stops the agent, its queued messages coming back to the editor, or else the command running.
    const current = target();
    if (!matchesKey(data, "escape") || typeof current === "string") return undefined;
    if (agentAtWork()) act(async () => {
      try {
        await takeBackQueued(current);
      } finally {
        await ask((ctx) => current.abort({}, ctx));
      }
    });
    else if (current.running.value !== null) act(() => ask((ctx) => current.stopCommand({}, ctx)));
    else return undefined;
    return { consume: true };
  });

  tui.addChild(header);
  tui.addChild(body);
  tui.addChild(notes);
  tui.addChild(errors);
  tui.addChild(working);
  tui.addChild(editorSlot);
  stage.restore();
  tui.addChild(footer);
  tui.setFocus(editor);
  tui.start();
  // What the agent loaded is the service's to say.
  void ask(async (ctx) => (await list.get()).loaded(ctx)).then((loaded) => {
    header.setLoaded(loaded);
    tui.requestRender();
  }, () => {});
  // Catalogs that change, such as a gateway's, are fetched again in the background, as pi does at its start.
  void options.models?.refresh({ allowNetwork: true }).then(() => tui.requestRender(), () => {});
  // A first conversation that cannot be started yet is no reason to quit: the failure shows, and /new tries again.
  act(begin);
  await done.promise;
  closed = true;
  quitting.abort();
  showWorking(undefined);
  tui.stop();
  leave();
  list.release();
}

/** This build's version, as its package names it. */
async function version(): Promise<string> {
  return (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function modelOf(view: ConversationView): ModelRef | undefined {
  return view.docs["pi.agent"]?.model as ModelRef | undefined;
}

function thinkingOf(view: ConversationView): string {
  return (view.docs["pi.agent"]?.thinkingLevel as string | undefined) ?? "off";
}

/** The branch the project's repository is on, as pi shows it beside the directory; undefined outside one. */
async function branch(directory: string): Promise<string | undefined> {
  const head = await readFile(join(directory, ".git", "HEAD"), "utf8").catch(() => undefined);
  return head?.match(/^ref: refs\/heads\/(.+)$/m)?.[1];
}

/**
 * Suspends to the background as pi does, the terminal restored meanwhile; the screen comes back when the shell resumes
 * the process. Nothing else may keep the process alive then, so a timer does, and ctrl+c there ends nothing.
 */
function suspend(tui: TUI): void {
  if (process.platform === "win32") return;
  const alive = setInterval(() => {}, 2 ** 30);
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.once("SIGCONT", () => {
    clearInterval(alive);
    process.off("SIGINT", ignore);
    tui.start();
    tui.requestRender(true);
  });
  tui.stop();
  process.kill(0, "SIGTSTP");
}
