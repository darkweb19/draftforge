import type { ModelAdapter } from "../adapter.js";
import { createProcessTransport, runHarnessProcess } from "./process.js";
import type { ProcessTransport } from "./process.js";

export interface ClaudeCliAdapterOptions {
  readonly transport?: ProcessTransport;
  readonly redactor?: (text: string) => string;
}

export function createClaudeCliAdapter(options: ClaudeCliAdapterOptions = {}): ModelAdapter {
  const transport = options.transport ?? createProcessTransport();

  return {
    capabilities: {
      id: "claude-cli",
      transport: "harness",
      authMode: "local-cli",
      roles: ["architect", "worker", "reviewer"],
    },
    async run(request) {
      const args = [
        "--print",
        "--output-format",
        "text",
        ...(request.model === "provider-default" ? [] : ["--model", request.model]),
      ];
      const text = await runHarnessProcess({
        command: "claude",
        args,
        stdin: formatPrompt(request.system, request.user),
        transport,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      });
      return { text };
    },
  };
}

function formatPrompt(system: string, user: string): string {
  return `System instructions:\n${system}\n\nUser request:\n${user}\n`;
}
