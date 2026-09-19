// A deliberately tiny TOML reader for the wrangler*.toml files in this repo --
// NOT a general TOML parser. It exists so the CI checks in
// test/ci_env_isolation.test.js can read binding config without adding a
// dependency. Supported (all the repo's wrangler files use): `[table]` and
// `[[array.of.tables]]` headers (dotted names kept verbatim as one key),
// `key = "string" | number | true/false | ["single", "line", "array"]`, and
// `#` comments (full-line or trailing, outside quotes). Anything else on a
// line (multi-line arrays, inline tables) is stored under its key as the raw
// string, never silently dropped -- and the parser test pins that the real
// files contain nothing it can't read.

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (c === "#" && !inStr) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw) {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((s) => parseValue(s));
  }
  return v; // raw fallback, see header
}

/**
 * Returns { top, tables, arrays }:
 *   top    - keys before any header
 *   tables - { "observability.logs": {...}, ... } for [name] headers
 *   arrays - { "d1_databases": [{...}, {...}], "queues.consumers": [...] } for [[name]] headers
 */
export function parseWranglerToml(text) {
  const top = {};
  const tables = {};
  const arrays = {};
  let current = top;
  for (const rawLine of text.split("\n")) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^\[\[\s*([^\]\s]+)\s*\]\]$/))) {
      current = {};
      (arrays[m[1]] ??= []).push(current);
    } else if ((m = line.match(/^\[\s*([^\]\s]+)\s*\]$/))) {
      current = {};
      tables[m[1]] = current;
    } else if ((m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/))) {
      current[m[1]] = parseValue(m[2]);
    }
  }
  return { top, tables, arrays };
}
