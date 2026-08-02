/**
 * Agent tools exposing the glasses to the OpenClaw agent.
 *
 * The phone's tool set is dynamic (foreground app changes, windows open and
 * close), so instead of mirroring each glasses tool as a first-class agent
 * tool, we register two fixed meta-tools:
 *
 *   glasses_list_tools  - list what the glasses can do right now
 *   glasses_call        - invoke one of those tools by name
 *
 * Fixed names keep the manifest `contracts.tools` declaration honest and are
 * robust against tool-policy filtering of undeclared dynamic names.
 */

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function flattenMcpContent(result) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const text = content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return text || JSON.stringify(result ?? null);
}

export function registerGlassesTools(api, service) {
  api.registerTool({
    name: "glasses_list_tools",
    label: "Glasses: list tools",
    description:
      "List the tools currently available on the user's smart glasses (Even Realities G2). " +
      "The set changes as apps open, close, and gain or lose focus, so list before calling " +
      "if you have not recently. Returns name, description, and JSON Schema for each tool. " +
      "Fails if the glasses are not connected.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const tools = await service.listGlassesTools();
      const summary = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return textResult(JSON.stringify({ connected: true, tools: summary }, null, 2));
    },
  });

  api.registerTool({
    name: "glasses_call",
    label: "Glasses: call tool",
    description:
      "Invoke a tool on the user's smart glasses (Even Realities G2), e.g. show an alert " +
      "on the lenses, read notifications, control media, or type into an open app. " +
      "Use glasses_list_tools to see what is currently available and each tool's argument " +
      "schema. Fails if the glasses are not connected.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Name of the glasses tool to call, as returned by glasses_list_tools.",
        },
        args: {
          type: "object",
          description: "Arguments matching the tool's input schema. Omit if none are needed.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const name = typeof params?.tool === "string" ? params.tool.trim() : "";
      if (!name) throw new Error("tool name is required");
      const result = await service.callGlassesTool(name, params?.args ?? {});
      const text = flattenMcpContent(result);
      if (result && result.isError) {
        throw new Error(text || `glasses tool ${name} failed`);
      }
      return textResult(text);
    },
  });
}
