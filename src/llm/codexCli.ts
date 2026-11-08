import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { Config } from "../config.js";
import { log } from "../utils.js";

export type Completion = { text: string; inputTokens?: number; outputTokens?: number };

/** Only the model is imported: user hooks, tools, plugins and project instructions stay out.
 * The CLI still loads global CODEX_HOME/AGENTS.md independently of config.toml.
 */
export async function configuredModel(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  const file = join(process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex"), "config.toml");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Не удалось прочитать название модели из настроек Codex. Укажите llm.model явно.");
  }
  try {
    const model = parse(source).model;
    if (model === undefined) return undefined;
    if (typeof model !== "string" || !model.trim()) throw new Error();
    return model.trim();
  } catch {
    // Parser errors can contain config fragments, so never include them in logs.
    throw new Error("Не удалось разобрать название модели в настройках Codex. Укажите llm.model явно.");
  }
}

/** Requires Codex CLI 0.166.0+; credentials remain managed by the already-authenticated CLI. */
export function codexArgs(llm: Config["llm"], instructionsFile: string, model?: string): string[] {
  return [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "--sandbox", "read-only", "--color", "never",
    ...(model ? ["--model", model] : []),
    "-c", `model_reasoning_effort=${JSON.stringify(llm.effort)}`,
    "-c", `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    "-c", "approval_policy=\"never\"",
    "-c", "project_doc_max_bytes=0",
    "-c", "skills.include_instructions=false",
    "-c", "skills.bundled.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "tools.update_plan.enabled=false",
    "-c", "web_search=\"disabled\"",
    ...[
      "shell_tool", "shell_snapshot", "view_image", "image_generation", "browser_use", "computer_use",
      "apps", "plugins", "remote_plugin", "plugin_discovery_prefetch", "hooks", "memories", "multi_agent",
      "multi_agent_v2", "code_mode", "code_mode_host", "skill_search", "skill_mcp_dependency_install",
      "tool_suggest", "sleep_tool", "goals",
    ].flatMap((feature) => ["--disable", feature]),
    "-",
  ];
}

export async function completeWithCodexCli(
  llm: Config["llm"],
  req: { system: string; prompt: string },
  signal?: AbortSignal,
): Promise<Completion> {
  const model = await configuredModel(llm.model);
  const dir = await mkdtemp(join(tmpdir(), "connect-codex-"));
  const started = Date.now();
  try {
    const instructions = join(dir, "instructions.txt");
    await writeFile(instructions, req.system, { mode: 0o600 });
    const args = codexArgs(llm, instructions, model);
    const stdout = await new Promise<string>((accept, reject) => {
      const child = execFile("codex", args, {
        cwd: dir,
        timeout: llm.timeoutSec * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        signal,
        // Preserve CLI authentication; resolve relative CODEX_HOME before changing cwd.
        env: { ...process.env, ...(process.env.CODEX_HOME ? { CODEX_HOME: resolve(process.env.CODEX_HOME) } : {}) },
      }, (error, out, stderr) => {
        if (!error) return accept(out);
        if (error.code === "ENOENT") return reject(new Error("`codex` не найден в PATH — установите Codex CLI и выполните codex login."));
        if (error.killed) return reject(new Error(`codex exec не ответил за ${llm.timeoutSec} с или превысил лимит вывода`));
        // Prefer structured errors over startup diagnostics. Never log the prompt or full stdout.
        try { parseCodexEvents(out); } catch (e) {
          if (e instanceof CodexTurnError) return reject(e);
        }
        reject(new Error(`codex exec завершился с ошибкой: ${stderr.trim().slice(-1000) || error.message}`));
      });
      child.stdin?.on("error", () => { /* Process completion reports early exits, including EPIPE. */ });
      child.stdin?.end(req.prompt);
    });
    const completion = parseCodexEvents(stdout);
    log.debug(`${model ?? "Codex (по умолчанию)"}: ${completion.inputTokens ?? "?"} in / ${completion.outputTokens ?? "?"} out tokens, ${((Date.now() - started) / 1000).toFixed(1)} с`);
    return completion;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class CodexTurnError extends Error {}

/** JSONL is a transport envelope; JSON inside an agent message is application data. */
export function parseCodexEvents(stdout: string): Completion {
  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
    let event: Record<string, any>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      event = value as Record<string, any>;
    } catch {
      throw new Error("codex exec вернул повреждённый поток JSONL");
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = event.error?.message ?? event.message ?? "неизвестная ошибка";
      throw new CodexTurnError(`codex exec вернул ошибку: ${String(message).slice(0, 500)}. Проверьте codex login и лимиты аккаунта.`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      // Commentary is not a completion; older CLI versions omit phase.
      if (!event.item.phase || event.item.phase === "final_answer") text = event.item.text.trim();
    }
    if (event.type === "turn.completed") {
      completed = true;
      inputTokens = typeof event.usage?.input_tokens === "number" ? event.usage.input_tokens : undefined;
      outputTokens = typeof event.usage?.output_tokens === "number" ? event.usage.output_tokens : undefined;
    }
  }
  if (!completed) throw new Error("codex exec не подтвердил завершение запроса");
  if (!text) throw new Error("codex exec вернул пустой итоговый ответ");
  return { text, inputTokens, outputTokens };
}
