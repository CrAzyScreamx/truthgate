export function total(xs: number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

export function totalBuggy(xs: number[]): number {
  let t = 0;
  for (let i = 0; i < xs.length - 1; i++) t += xs[i]!; // planted off-by-one: skips the last item
  return t;
}
