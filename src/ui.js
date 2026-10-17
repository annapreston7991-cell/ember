/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import readline from 'node:readline';
import kleur from 'kleur';
import { createTwoFilesPatch } from 'diff';

export const c = kleur;

export const EMBER = c.bold().red('ember');

export function banner(model) {
  return [
    c.red('   ▲  ') + c.bold().yellow('Ember') + c.gray('  · local AI coding agent · part of the LLYVerse'),
    c.red('  ▲▲▲ ') + c.gray(`model ${model} · /help for commands · /exit to quit`)
  ].join('\n');
}

export class UI {
  constructor({ yes = false, input = process.stdin, output = process.stdout } = {}) {
    this.yes = yes;
    this.input = input;
    this.output = output;
    this.rl = null;
    this.lineQueue = [];
    this.waiters = [];
    this.closed = false;
  }

  _ensure() {
    if (this.rl) return;
    this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: !!this.input.isTTY });
    this.rl.on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l); else this.lineQueue.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
    this.rl.on('SIGINT', () => { if (this.onInterrupt) this.onInterrupt(); else { this.print(''); process.exit(130); } });
  }

  /** Ask a question; resolves with the line, or null on EOF. */
  ask(prompt) {
    this._ensure();
    this.output.write(prompt);
    if (this.lineQueue.length) return Promise.resolve(this.lineQueue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }

  /** y / n / a(lways). Returns 'y', 'n' or 'a'. */
  async confirm(question, { allowAlways = true, defaultNo = true } = {}) {
    if (this.yes) { this.print(c.gray(`${question} → auto-approved (--yes)`)); return 'y'; }
    const opts = allowAlways ? '[y]es / [n]o / [a]lways' : '[y]es / [n]o';
    const ans = await this.ask(`${c.yellow('?')} ${question} ${c.gray(opts)} `);
    if (ans === null) return 'n';
    const a = ans.trim().toLowerCase();
    if (a === 'a' || a === 'always') return allowAlways ? 'a' : 'y';
    if (a === 'y' || a === 'yes') return 'y';
    if (!a && !defaultNo) return 'y';
    return 'n';
  }

  /** Extra confirmation for destructive actions: user must type "yes" (never auto-approved). */
  async confirmDangerous(question) {
    if (!this.input.isTTY && this.yes) {
      this.print(c.red(`Refusing dangerous action without a human: ${question}`));
      return false;
    }
    const ans = await this.ask(`${c.bgRed().white(' DANGER ')} ${question}\n  Type ${c.bold('yes')} to run it anyway: `);
    return (ans || '').trim() === 'yes';
  }

  print(s = '') { this.output.write(s + '\n'); }
  write(s) { this.output.write(s); }
  info(s) { this.print(c.cyan('› ') + s); }
  warn(s) { this.print(c.yellow('! ') + s); }
  error(s) { this.print(c.red('✗ ') + s); }
  ok(s) { this.print(c.green('✓ ') + s); }

  close() { if (this.rl) this.rl.close(); }
}

export function renderDiff(file, before, after) {
  const patch = createTwoFilesPatch(file, file, before ?? '', after ?? '', before == null ? '(new file)' : '', '', { context: 3 });
  const lines = patch.split('\n').slice(2); // drop "===" and "Index" style header
  const out = [];
  let shown = 0;
  for (const l of lines) {
    if (shown > 400) { out.push(c.gray(`… diff truncated (${lines.length - shown} more lines)`)); break; }
    shown++;
    if (l.startsWith('+++') || l.startsWith('---')) out.push(c.bold(l));
    else if (l.startsWith('+')) out.push(c.green(l));
    else if (l.startsWith('-')) out.push(c.red(l));
    else if (l.startsWith('@@')) out.push(c.cyan(l));
    else out.push(c.gray(l));
  }
  return out.join('\n');
}

export function diffStats(before, after) {
  const a = (before ?? '').split('\n'), b = (after ?? '').split('\n');
  const patch = createTwoFilesPatch('a', 'b', before ?? '', after ?? '');
  let add = 0, del = 0;
  for (const l of patch.split('\n').slice(4)) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del, linesBefore: a.length, linesAfter: b.length };
}
