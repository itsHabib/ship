/**
 * Provider-neutral structural equivalents of cursor SDK config shapes.
 * Consumers never destructure these — they pass through to the runner.
 */

/** Stdio MCP server wiring. */
export interface StdioMcpServerConfig {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

/** HTTP MCP server wiring. */
export interface HttpMcpServerConfig {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Record<string, string>;
}

/** Stdio or HTTP MCP server config (structural mirror of `@cursor/sdk`). */
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

/** Inline subagent definition (structural mirror of `@cursor/sdk`). */
export interface AgentDefinition {
  readonly description?: string;
  readonly prompt?: string;
  readonly model?:
    | string
    | {
        readonly id: string;
        readonly params?: readonly { readonly id: string; readonly value: string | boolean }[];
      };
  readonly tools?: readonly string[];
}
