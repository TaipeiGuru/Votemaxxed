import { createClient } from "@supabase/supabase-js";

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const MAX_PROMPT_TEXT_LEN = 500;

let _supabase = null;
function supabaseClient() {
  if (_supabase) return _supabase;
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    throw new Error("Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  _supabase = createClient(url, key);
  return _supabase;
}

async function fetchActivePrompts() {
  const supabase = supabaseClient();
  const { data, error } = await supabase
    .from("prompts")
    .select("id,text")
    .eq("is_deleted", false);
  if (error) throw new Error(`Failed to fetch prompts: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

function normalizedCustomPrompts(customPromptsInput) {
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
  return customs;
}

/**
 * Build exactly `n` prompts: every custom string is included first (deduped), then random
 * active DB prompts fill the rest. Final order is shuffled so assignments are not predictable.
 * @param {number} n — players / prompts needed
 * @param {string[] | undefined} customPromptsInput — host-added prompts (guaranteed in pool)
 * @returns {{ id: string, text: string }[]}
 */
export async function buildGamePrompts(n, customPromptsInput) {
  const customs = normalizedCustomPrompts(customPromptsInput);
  if (customs.length > n) {
    throw new Error(
      `Too many custom prompts (${customs.length}). You can add at most ${n} (one per player).`
    );
  }

  const activeRows = await fetchActivePrompts();
  const pool = customs.map((text, i) => ({ id: `custom-${i}`, text }));
  const used = new Set(customs.map((t) => t.toLowerCase()));

  const fillers = shuffle(activeRows).filter((row) => {
    const text = String(row?.text || "").trim();
    if (!text) return false;
    return !used.has(text.toLowerCase());
  });

  let fi = 0;
  while (pool.length < n && fi < fillers.length) {
    const row = fillers[fi++];
    pool.push({
      id: String(row.id),
      text: String(row.text).slice(0, MAX_PROMPT_TEXT_LEN),
    });
  }
  if (pool.length < n) {
    throw new Error(
      `Not enough active prompts to fill game. Need ${n}, have ${pool.length}.`
    );
  }

  const shuffled = shuffle(pool);
  return shuffled.map((row) => ({ id: row.id, text: row.text }));
}

/** Build per-prompt alternate text map from active DB prompts. */
export async function buildAlternatePromptMap(gamePrompts) {
  const primaryKeys = new Set(
    (gamePrompts || []).map((p) => String(p?.text ?? "").trim().toLowerCase())
  );
  const rows = await fetchActivePrompts();
  const pool = shuffle(rows).filter((row) => {
    const text = String(row?.text || "").trim();
    if (!text) return false;
    return !primaryKeys.has(text.toLowerCase());
  });

  const out = {};
  const n = gamePrompts?.length ?? 0;
  for (let i = 0; i < n; i++) {
    out[String(i)] = String(pool.pop()?.text || "").slice(0, MAX_PROMPT_TEXT_LEN);
  }
  return out;
}

/** Increment report count and soft-delete when threshold is reached. */
export async function reportPrompt(promptId, reporterKey) {
  const idNum = Number(promptId);
  if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
    return { ok: false, reason: "invalid_id" };
  }
  const reporter = String(reporterKey || "").trim().slice(0, 128);
  if (!reporter) {
    return { ok: false, reason: "invalid_reporter" };
  }
  const supabase = supabaseClient();

  const { data, error } = await supabase.rpc("report_prompt", {
    p_prompt_id: idNum,
    p_reporter_key: reporter,
  });
  if (error) {
    throw new Error(`Failed to report prompt: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    const { data: existing, error: readErr } = await supabase
      .from("prompts")
      .select("id")
      .eq("id", idNum)
      .eq("is_deleted", false)
      .limit(1);
    if (readErr) throw new Error(`Failed to verify prompt report status: ${readErr.message}`);
    return { ok: false, reason: (existing || []).length > 0 ? "already_reported" : "not_found_or_deleted" };
  }
  return {
    ok: true,
    id: row.id,
    text: row.text,
    reportCount: row.report_count,
    isDeleted: row.is_deleted,
  };
}
