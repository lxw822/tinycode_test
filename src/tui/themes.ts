import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/**
 * TinyCode's colors — hand-rolled SGR wrapping rather than a theme package.
 *
 * pi-tui ships no default theme (every component takes its theme as an
 * argument), so this module is the single place where the palette lives.
 * Wrappers always emit a full reset after the span, which keeps nested calls
 * (`bold(red("x"))`) from bleeding into the rest of the line.
 */

const ESC = String.fromCharCode(27) + "[";

const wrap = (code: string, text: string): string => `${ESC}${code}m${text}${ESC}0m`;

export const bold = (text: string): string => wrap("1", text);
export const dim = (text: string): string => wrap("2", text);
export const italic = (text: string): string => wrap("3", text);
export const underline = (text: string): string => wrap("4", text);
export const inverse = (text: string): string => wrap("7", text);
export const strikethrough = (text: string): string => wrap("9", text);

export const red = (text: string): string => wrap("31", text);
export const green = (text: string): string => wrap("32", text);
export const yellow = (text: string): string => wrap("33", text);
export const blue = (text: string): string => wrap("34", text);
export const magenta = (text: string): string => wrap("35", text);
export const cyan = (text: string): string => wrap("36", text);
/** "bright black" — the conventional secondary/UI gray. */
export const gray = (text: string): string => wrap("90", text);

/** Editor border + its embedded `/` autocomplete popup. */
export const editorTheme: EditorTheme = {
  borderColor: (text: string) => gray(text),
  selectList: {
    selectedPrefix: (text: string) => cyan(text),
    selectedText: (text: string) => bold(text),
    description: (text: string) => dim(text),
    scrollInfo: (text: string) => dim(text),
    noMatch: (text: string) => red(text),
  },
};

/** Permission dialog list — same family as the editor so they read as one UI. */
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => cyan(text),
  selectedText: (text: string) => bold(text),
  description: (text: string) => dim(text),
  scrollInfo: (text: string) => dim(text),
  noMatch: (text: string) => red(text),
};

/** Assistant output. Headings cyan, code magenta, quotes dim — quiet, not loud. */
export const markdownTheme: MarkdownTheme = {
  heading: (text: string) => bold(cyan(text)),
  link: (text: string) => underline(cyan(text)),
  linkUrl: (text: string) => dim(text),
  code: (text: string) => magenta(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => gray(text),
  quote: (text: string) => dim(text),
  quoteBorder: (text: string) => gray(text),
  hr: (text: string) => gray(text),
  listBullet: (text: string) => cyan(text),
  bold,
  italic,
  strikethrough,
  underline,
};
