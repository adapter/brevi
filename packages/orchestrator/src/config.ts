import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH, configSchema, type BreviConfig } from "@brevi/shared";

export async function loadConfig(path: string = CONFIG_PATH): Promise<BreviConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`No brevi config found at ${path}. Run \`brevi init\` first.`);
  }
  return configSchema.parse(JSON.parse(raw));
}

export async function saveConfig(
  config: unknown,
  path: string = CONFIG_PATH,
): Promise<BreviConfig> {
  const parsed = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}
