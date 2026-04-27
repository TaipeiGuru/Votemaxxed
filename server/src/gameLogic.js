function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildDerangement(ids) {
  if (ids.length < 2) throw new Error("Need at least 2 players");
  // Retry shuffled permutations until no player is paired with themselves.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = shuffle(ids);
    if (candidate.every((id, i) => id !== ids[i])) return candidate;
  }
  throw new Error("Could not generate randomized prompt assignments.");
}

export function buildAssignments(playerIds) {
  const n = playerIds.length;
  if (n < 2) throw new Error("Need at least 2 players");
  const primaryAuthors = shuffle(playerIds);
  const partnerAuthors = buildDerangement(primaryAuthors);
  const assignments = [];
  for (let i = 0; i < n; i++) {
    assignments.push({
      promptIndex: i,
      authorIds: [primaryAuthors[i], partnerAuthors[i]],
    });
  }
  return assignments;
}

export function scoreShowdown(votesForA, votesForB, authorA, authorB) {
  const total = votesForA + votesForB;
  const out = { [authorA]: 0, [authorB]: 0 };
  if (total === 0) return out;
  out[authorA] = (votesForA / total) * 100;
  out[authorB] = (votesForB / total) * 100;
  return out;
}

export function isUnanimous(votesForA, votesForB) {
  if (votesForA > 0 && votesForB === 0) return { winner: "A" };
  if (votesForB > 0 && votesForA === 0) return { winner: "B" };
  return null;
}
