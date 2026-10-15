/** Subsequence match with a score favouring prefixes, word starts and tight runs. null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s\-_/:.…]/.test(t[at - 1]!);
    run = at === ti ? run + 1 : 0;
    score += 1 + (wordStart ? 6 : 0) + run * 2 - Math.min(at - ti, 8) * 0.25;
    ti = at + 1;
  }
  if (t.startsWith(q)) score += 12;
  else if (t.includes(q)) score += 6;
  return score - t.length * 0.02;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, text(item));
    if (s !== null) scored.push({ item, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}
