/**
 * Provider-neutral model interface for the agent: one turn, optionally with tools (function calling)
 * or a JSON response schema. The Gemini adapter is the production path; tests inject a scripted double.
 */
import { GoogleGenAI, type Content, type ThinkingLevel } from "@google/genai";
import { config } from "../config.js";
import { LlmUnavailableError, normalizeStopReason, withBackoff, withTimeout } from "../extraction/extractor.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCallRequest {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentHistoryItem =
  | { role: "user"; text: string }
  /** `raw` is the provider's own representation of the turn, replayed as-is (keeps any thought signatures). */
  | { role: "model"; text: string; toolCalls: ToolCallRequest[]; raw?: unknown }
  | { role: "tool"; results: { id?: string; name: string; output: unknown }[] };

export interface AgentTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason: string;
  model: string;
  raw?: unknown;
}

export interface AgentTurnRequest {
  system: string;
  history: AgentHistoryItem[];
  tools?: ToolSpec[];
  /** When set, the model must answer with JSON matching this schema (no tools). */
  jsonSchema?: Record<string, unknown>;
}

export type AgentLlm = (req: AgentTurnRequest) => Promise<AgentTurn>;

function toContents(history: AgentHistoryItem[]): Content[] {
  return history.map((h): Content => {
    if (h.role === "user") return { role: "user", parts: [{ text: h.text }] };
    if (h.role === "model") {
      if (h.raw) return h.raw as Content;
      return {
        role: "model",
        parts: [...(h.text ? [{ text: h.text }] : []), ...h.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } }))],
      };
    }
    return {
      role: "user",
      parts: h.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: { output: r.output } } })),
    };
  });
}

export function createGeminiAgentLlm(model: string = config.agentModel): AgentLlm {
  let client: GoogleGenAI | null = null;
  return async ({ system, history, tools, jsonSchema }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new LlmUnavailableError("GEMINI_API_KEY is not set");
    const ai = (client ??= new GoogleGenAI({ apiKey }));
    let response;
    try {
      response = await withBackoff(() =>
        withTimeout(
          (abortSignal) =>
            ai.models.generateContent({
              model,
              contents: toContents(history),
              config: {
                abortSignal,
                systemInstruction: system,
                // Thinking tokens count against the output limit; keep the limit generous and thinking modest
                // (the task is retrieval + writing from given figures, not open-ended reasoning).
                maxOutputTokens: 32_000,
                thinkingConfig: { thinkingLevel: config.agentThinkingLevel as ThinkingLevel },
                ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}),
                ...(jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: jsonSchema } : {}),
              },
            }),
          config.agentTimeoutMs,
        ),
      );
    } catch (err) {
      throw new LlmUnavailableError(`Agent model call failed: ${(err as Error).message}`, { cause: err });
    }
    const content = response.candidates?.[0]?.content;
    return {
      text: (content?.parts ?? []).map((p) => p.text ?? "").join(""),
      toolCalls: (response.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name ?? "", args: (c.args ?? {}) as Record<string, unknown> })),
      stopReason: normalizeStopReason(response.candidates?.[0]?.finishReason, Boolean(response.promptFeedback?.blockReason)),
      model: response.modelVersion ?? model,
      raw: content,
    };
  };
}
