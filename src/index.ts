import { config as loadEnvironment } from "dotenv";

import { paths } from "./config.js";
import { matchAccrualsToTransactions } from "./matching/matcher.js";
import type { AccrualEntry, Transaction } from "./types.js";
import { readJsonArray, writeJsonFile } from "./utils/json-file.js";

loadEnvironment({ quiet: true });

async function main(): Promise<void> {
  const [accrualEntries, transactions] = await Promise.all([
    readJsonArray<AccrualEntry>(paths.accrualEntries),
    readJsonArray<Transaction>(paths.newTransactions),
  ]);

  const matches = await matchAccrualsToTransactions(
    accrualEntries,
    transactions,
  );

  await writeJsonFile(paths.matchesOutput, matches);
}

main().catch((error: unknown) => {
  console.error("Accounting service failed:", error);
  process.exitCode = 1;
});
