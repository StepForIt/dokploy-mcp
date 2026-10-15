import type { ZodObject, ZodRawShape } from "zod";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  tag: string;
  method: "GET" | "POST";
  path: string;
  schema: ZodObject<ZodRawShape>;
  annotations?: ToolAnnotations;
  /** Runs the tool itself instead of forwarding the input to `method` + `path`. */
  run?: (input: Record<string, unknown>) => Promise<unknown>;
  /** Hides secret inputs from the logs (applied when DOKPLOY_REDACT_ENV is on). */
  maskInput?: (input: Record<string, unknown>) => Record<string, unknown>;
}
