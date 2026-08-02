import { createBridgeService } from "./lib/bridge-service.js";
import { registerGlassesTools } from "./lib/tools.js";

export default function register(api) {
  if (!api || typeof api.registerService !== "function") {
    throw new Error("faceclaw-bridge requires api.registerService()");
  }

  const service = createBridgeService({
    logger: api.logger,
    getPluginConfig: () => api.pluginConfig || {},
    runtime: api.runtime,
    fallbackConfig: api.config,
  });

  api.registerService({
    id: "faceclaw-bridge",
    start: () => service.start(),
    stop: () => service.stop(),
  });

  registerGlassesTools(api, service);
}
