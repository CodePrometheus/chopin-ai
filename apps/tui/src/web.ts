import type { Command } from "@chopin-ai/core";
import { openBrowser } from "./browser.js";
import { pickInTerminal } from "./model.js";
import { openProject } from "./project.js";

/** This project in the browser, sharing the service every other chopin of the project uses. */
export const webCommand: Command = {
  name: "web",
  args: "",
  summary: "open this project in the browser",
  run: async (args, io) => {
    if (args.length > 0) {
      io.err("usage: chopin web");
      return 2;
    }
    const project = await openProject(process.cwd(), pickInTerminal);
    openBrowser(project.page);
    io.err(`chopin: opening this project in the browser; if none comes up, visit ${project.page.href}`);
    return 0;
  },
};
