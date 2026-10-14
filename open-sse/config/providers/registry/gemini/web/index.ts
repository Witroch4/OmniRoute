import type { RegistryEntry } from "../../../shared.ts";
import { GEMINI_WEB_MODELS } from "./models.ts";

export const gemini_webProvider: RegistryEntry = {
  id: "gemini-web",
  alias: "gweb",
  format: "openai",
  executor: "gemini-web",
  baseUrl: "https://gemini.google.com/app",
  authType: "apikey",
  authHeader: "cookie",
  models: GEMINI_WEB_MODELS.map(({ id, name }) => ({ id, name })),
};
