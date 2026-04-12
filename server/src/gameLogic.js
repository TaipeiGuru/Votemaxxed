/**
 * Round-robin: for N players, N prompts. Prompt i is assigned to player i and (i+1) % N.
 * Each player appears on exactly two prompts.
 */
export function buildAssignments(playerIds) {
  const n = playerIds.length;
  if (n < 2) throw new Error("Need at least 2 players");
  const assignments = [];
  for (let i = 0; i < n; i++) {
    assignments.push({
      promptIndex: i,
      authorIds: [playerIds[i], playerIds[(i + 1) % n]],
    });
  }
  return assignments;
}

/**
 * Points = (votes / totalVotes) * 100 per answer. Returns points by author id for this showdown.
 */
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
