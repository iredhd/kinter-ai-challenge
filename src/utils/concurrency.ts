export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function runLane(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];

      if (item === undefined) {
        continue;
      }

      results[index] = await worker(item, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, runLane));

  return results;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
