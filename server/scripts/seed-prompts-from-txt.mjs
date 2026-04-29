import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

function parseDotEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

function normalizePrompt(line) {
  const withoutNumber = line.replace(/^\s*\d+\s*[.)-]\s*/, "");
  return withoutNumber.trim();
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, "../..");
  const envPath = path.join(repoRoot, "server", ".env");
  const promptsPath = path.join(repoRoot, "client", "prompts.txt");

  const envRaw = await fs.readFile(envPath, "utf8");
  const env = parseDotEnv(envRaw);
  const supabaseUrl = String(env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in server/.env");
  }

  const txtRaw = await fs.readFile(promptsPath, "utf8");
  const seen = new Set();
  const cleaned = [];
  for (const line of txtRaw.split(/\r?\n/)) {
    const prompt = normalizePrompt(line);
    if (!prompt) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(prompt);
  }

  if (cleaned.length === 0) {
    throw new Error("No prompts found after cleaning.");
  }

  const payload = cleaned.map((text) => ({
    text,
    report_count: 0,
    is_deleted: false,
  }));

  const res = await fetch(`${supabaseUrl}/rest/v1/prompts?on_conflict=text`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase insert failed (${res.status}): ${bodyText}`);
  }

  let insertedRows = [];
  try {
    insertedRows = JSON.parse(bodyText);
  } catch {
    insertedRows = [];
  }

  const countRes = await fetch(`${supabaseUrl}/rest/v1/prompts?select=id`, {
    method: "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "count=exact",
    },
  });
  if (!countRes.ok) {
    throw new Error(`Supabase count check failed (${countRes.status})`);
  }
  const totalCount = Number(countRes.headers.get("content-range")?.split("/")[1] || "0");

  console.log(
    JSON.stringify(
      {
        sourceLines: txtRaw.split(/\r?\n/).length,
        cleanedUniquePrompts: cleaned.length,
        newlyInsertedRows: insertedRows.length,
        totalPromptsInTable: totalCount,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
