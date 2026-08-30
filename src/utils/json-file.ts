import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(contents);

    if (!Array.isArray(parsed)) {
      throw new TypeError("Expected the root JSON value to be an array");
    }

    return parsed as T[];
  } catch (error) {
    throw new Error(`Unable to read JSON array from "${filePath}"`, {
      cause: error,
    });
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
