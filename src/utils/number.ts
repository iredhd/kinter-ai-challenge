export function round(value: number, decimalPlaces = 4): number {
  const factor = 10 ** decimalPlaces;

  return Math.round(value * factor) / factor;
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}
