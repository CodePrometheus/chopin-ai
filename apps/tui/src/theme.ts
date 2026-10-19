import { styleText } from "node:util";
import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

type Format = Parameters<typeof styleText>[0];

/** A style from Node's own terminal styling, which leaves text plain where the terminal has no colors. */
export const style = (format: Format) => (text: string): string => styleText(format, text);

export const markdownTheme: MarkdownTheme = {
  heading: style(["bold", "cyan"]),
  link: style("underline"),
  linkUrl: style("dim"),
  code: style("yellow"),
  codeBlock: (text) => text,
  codeBlockBorder: style("dim"),
  quote: style("italic"),
  quoteBorder: style("dim"),
  hr: style("dim"),
  listBullet: style("cyan"),
  bold: style("bold"),
  italic: style("italic"),
  strikethrough: style("strikethrough"),
  underline: style("underline"),
};

export const editorTheme: EditorTheme = {
  borderColor: style("dim"),
  selectList: {
    selectedPrefix: style("cyan"),
    selectedText: style("cyan"),
    description: style("dim"),
    scrollInfo: style("dim"),
    noMatch: style("dim"),
  },
};
