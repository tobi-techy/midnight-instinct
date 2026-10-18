/**
 * Memory is markdown the owner can read and edit by hand: memory/MEMORY.md for durable
 * facts and memory/journal/YYYY-MM-DD.md for what happened each day. The prompt builder
 * injects `digest()`; Pi compaction keeps the conversation itself small.
 *
 * A public agent keeps a notebook per person as well, in
 * memory/people/<hash>/MEMORY.md, so anyone who messages it gets an agent that knows
 * them without ever sharing the owner's notebook or another person's.
 */
import { createHash } from "node:crypto";
import type { StateDir } from "./state.js";

const DURABLE_TEMPLATE = `# Memory

Durable facts about the owner, their people and their preferences. Short lines. One fact per line.
`;

/** The header a person's own notebook starts with, so a reader knows whose it is. */
const PERSON_TEMPLATE = `# Memory

What this person told me and what matters to them. Short lines. One fact per line.
`;

/** Local calendar date, YYYY-MM-DD. The agent's VM runs in the owner's chosen TZ or UTC. */
export function journalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeOfDay(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return text.slice(0, cut > 0 ? cut : max).trimEnd() + "\n...";
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.indexOf("\n", text.length - max);
  return "...\n" + text.slice(start > 0 ? start + 1 : text.length - max).trimStart();
}

export class MemoryStore {
  private readonly state: StateDir;
  /** "" for the owner's notebook; "people/<hash>" for one person's. */
  private readonly root: string;

  constructor(state: StateDir, root = "") {
    this.state = state;
    this.root = root.replace(/^\/+|\/+$/g, "");
  }

  /**
   * The notebook of one person, keyed by a hash of their address or principal id: the file
   * does not name the number that wrote it, two people never share a file, and neither of
   * them can reach the owner's MEMORY.md. The same idea as a vault scope.
   */
  static forPerson(state: StateDir, personKey: string): MemoryStore {
    const hash = createHash("sha256").update(personKey.trim()).digest("hex").slice(0, 32);
    return new MemoryStore(state, `people/${hash}`);
  }

  /** Where this store writes, relative to the data dir. Used by docs, tests and the smoke run. */
  durablePath(): string {
    return this.root ? `memory/${this.root}/MEMORY.md` : "memory/MEMORY.md";
  }

  private journalDir(): string {
    return this.root ? `memory/${this.root}/journal` : "memory/journal";
  }

  readDurable(): string {
    return this.state.readText(this.durablePath(), "");
  }

  appendDurable(text: string): void {
    const current = this.readDurable();
    const base = current || (this.root ? PERSON_TEMPLATE : DURABLE_TEMPLATE);
    const sep = base.endsWith("\n") ? "" : "\n";
    this.state.writeText(this.durablePath(), `${base}${sep}${text.trim()}\n`);
  }

  replaceDurable(text: string): void {
    this.state.writeText(this.durablePath(), text.endsWith("\n") ? text : text + "\n");
  }

  journalPath(date: Date = new Date()): string {
    return `${this.journalDir()}/${journalDate(date)}.md`;
  }

  readJournal(date: Date = new Date()): string {
    return this.state.readText(this.journalPath(date), "");
  }

  appendJournal(text: string, date: Date = new Date()): void {
    const name = this.journalPath(date);
    const existing = this.state.readText(name, "");
    const lines = text
      .trim()
      .split("\n")
      .map((l, i) => (i === 0 ? `- ${timeOfDay(date)} ${l}` : `  ${l}`))
      .join("\n");
    const header = existing ? "" : `# ${journalDate(date)}\n\n`;
    this.state.writeText(name, `${existing}${header}${lines}\n`);
  }

  /**
   * The owner's preferences only: the body of a `## Preferences` heading in MEMORY.md
   * (case-insensitive, any heading level), up to `maxChars`. Non-owners who may know the
   * owner's preferences get this and nothing else from memory. Returns "" when there is no
   * such section, so an unstructured MEMORY.md never leaks.
   */
  preferencesDigest(maxChars = 1500): string {
    const durable = this.readDurable();
    const match = /^(#{1,6})\s*preferences\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(durable);
    const body = match?.[2]?.trim() ?? "";
    if (!body) return "";
    return head(body, maxChars);
  }

  /**
   * What the model sees every turn: the start of MEMORY.md and the end of the last
   * two days of journal. The budget is split 60/25/15 so durable facts win.
   */
  digest(maxChars = 4000, now: Date = new Date()): string {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const durable = this.readDurable().trim();
    const today = this.readJournal(now).trim();
    const prior = this.readJournal(yesterday).trim();
    const parts: string[] = [];
    if (durable) parts.push(head(durable, Math.floor(maxChars * 0.6)));
    if (today) parts.push(`## Journal, today (${journalDate(now)})\n${tail(today, Math.floor(maxChars * 0.25))}`);
    if (prior) parts.push(`## Journal, yesterday (${journalDate(yesterday)})\n${tail(prior, Math.floor(maxChars * 0.15))}`);
    return parts.join("\n\n");
  }
}
