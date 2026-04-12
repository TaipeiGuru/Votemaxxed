/** Built-in list for testing — no database. */

export const HARDCODED_PROMPTS = [
  "The worst thing to hear your pilot say over the intercom right before takeoff.",
  "A rejected slogan for a brand of ultra-cheap toilet paper.",
  "The most awkward thing to say immediately after a first kiss.",
  "A weird reason to break up with someone after only one date.",
  "What the Statue of Liberty is actually thinking while staring at the ocean.",
  "The name of a high-end restaurant that only serves food found in a dumpster.",
  "The real reason why the dinosaurs went extinct.",
  "Something you shouldn't shout while in the middle of a library.",
  "A terrible name for a new brand of \"healthy\" cigarettes.",
  "The secret hobby your cat has when you aren't at home.",
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const MAX_PROMPT_TEXT_LEN = 500;

/**
 * Build exactly `n` prompts: every custom string is included first (deduped), then random
 * hardcoded fills the rest. Final order is shuffled so assignments are not predictable.
 * @param {number} n — players / prompts needed
 * @param {string[] | undefined} customPromptsInput — host-added prompts (guaranteed in pool)
 * @returns {{ id: string, text: string }[]}
 */
export function buildGamePrompts(n, customPromptsInput) {
  if (n > HARDCODED_PROMPTS.length) {
    throw new Error(
      `Need at most ${HARDCODED_PROMPTS.length} players with the built-in prompt list.`
    );
  }
  const customs = [];
  const seen = new Set();
  for (const raw of customPromptsInput || []) {
    const t = String(raw || "")
      .trim()
      .slice(0, MAX_PROMPT_TEXT_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    customs.push(t);
  }
  if (customs.length > n) {
    throw new Error(
      `Too many custom prompts (${customs.length}). You can add at most ${n} (one per player).`
    );
  }
  const pool = [...customs];
  const used = new Set(customs.map((t) => t.toLowerCase()));
  const filler = shuffle([...HARDCODED_PROMPTS]).filter(
    (t) => !used.has(t.toLowerCase())
  );
  let fi = 0;
  while (pool.length < n && fi < filler.length) {
    pool.push(filler[fi++]);
  }
  if (pool.length < n) {
    throw new Error(
      "Not enough unique prompts to fill the game. Reduce overlapping custom prompts."
    );
  }
  const shuffled = shuffle(pool);
  return shuffled.map((text, i) => ({
    id: `p-${i}`,
    text,
  }));
}

/**
 * @param {number} n — number of players (need n distinct prompts)
 * @returns {{ id: string, text: string }[]}
 */
export function pickRandomPrompts(n) {
  return buildGamePrompts(n, []);
}
