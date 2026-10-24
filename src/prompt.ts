import process from "node:process";
import * as readline from "node:readline/promises";

export interface Choice<T> {
  label: string;
  value: T;
  recommended?: boolean;
}

export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

function streams(io?: PromptIO): PromptIO {
  return {
    input: io?.input ?? process.stdin,
    output: io?.output ?? process.stdout,
  };
}

export async function ask(question: string, io?: PromptIO): Promise<string> {
  const s = streams(io);
  const rl = readline.createInterface({
    input: s.input as NodeJS.ReadableStream,
    output: s.output as NodeJS.WritableStream,
  });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export async function askChoice<T>(
  header: string,
  choices: Choice<T>[],
  io?: PromptIO,
): Promise<T> {
  const s = streams(io);
  const write = (line: string) => s.output.write(line + "\n");
  if (header) write(header);
  const rec = choices.findIndex((c) => c.recommended);
  choices.forEach((c, i) => {
    write(`  [${i + 1}] ${c.label}${c.recommended ? "  (recommended)" : ""}`);
  });
  const hint = rec >= 0 ? ` (Enter = ${rec + 1})` : "";
  const ans = await ask(`>${hint} `, io);
  if (ans === "" && rec >= 0) {
    write(`  -> ${choices[rec]!.label}`);
    return choices[rec]!.value;
  }
  const idx = Number.parseInt(ans, 10) - 1;
  if (Number.isInteger(idx) && choices[idx]) return choices[idx]!.value;
  if (rec >= 0) return choices[rec]!.value;
  return choices[0]!.value;
}
