import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HELIOS_DIR } from "../paths.js";

const CONFIG_DIR = HELIOS_DIR;
const PREFS_FILE = join(CONFIG_DIR, "preferences.json");

export interface Preferences {
  lastProvider?: "claude" | "openai";
  claudeAuthMode?: "cli" | "api";
  model?: string;
  reasoningEffort?: string;
}

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadPreferences(): Preferences {
  try {
    if (!existsSync(PREFS_FILE)) return {};
    return JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Partial<Preferences>): void {
  ensureDir();
  const existing = loadPreferences();
  writeFileSync(
    PREFS_FILE,
    JSON.stringify({ ...existing, ...prefs }, null, 2),
    "utf-8",
  );
}
