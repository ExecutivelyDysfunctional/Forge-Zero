/**
 * Exporters. A prompt pack is only useful once it leaves the app, so the same
 * structure renders three ways: the canonical JSON (re-importable), a readable
 * markdown runbook, per-stage text files, and a copy-paste curl script that hits
 * the provider directly - the last one matters because a free-tier user is most
 * likely scripting this in a terminal, not opening a browser.
 */

import { MODE_LABELS } from './blueprint-labels.js';

export function packToMarkdown(pack) {
  const L = [];
  const m = pack.model;
  L.push(`# ${pack.spec.name} — Forge-Zero prompt pack`);
  L.push('');
  L.push(`- **Target:** ${pack.modeLabel}`);
  L.push(`- **Model:** ${m.label} (\`${m.id}\`) — ${m.contextWindow} context, ${m.outputCeiling} output ceiling`);
  L.push(`- **Strategy:** ${pack.strategy} — ${pack.strategyNote}`);
  L.push(`- **Size estimate:** ~${pack.sizeBudget.lines} lines / ~${pack.sizeBudget.tokens} tokens`);
  L.push(`- **Requests:** ${pack.stageCount} stages${pack.budget.projectedRequests > pack.stageCount ? ` (~${pack.budget.projectedRequests} counting repairs)` : ''}`);
  L.push('');
  L.push('## Free-tier budget');
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Daily request use | ${pack.budget.rpdPct ?? 'n/a'}%${m.freeTier?.rpd ? ` of ${m.freeTier.rpd} RPD` : ''} |`);
  L.push(`| Daily token use | ${pack.budget.tpdPct ?? 'n/a'}%${m.freeTier?.tpd ? ` of ${m.freeTier.tpd} TPD` : ''} |`);
  L.push(`| Min spacing | ${pack.budget.minSpacingSec}s between stages |`);
  L.push(`| Estimated wall clock | ~${pack.budget.etaMinutes} min |`);
  L.push('');
  if (pack.budget.warnings.length) {
    L.push('## Warnings');
    L.push('');
    for (const w of pack.budget.warnings) {
      L.push(`- **[${w.severity}] ${w.title}** — ${w.detail}`);
    }
    L.push('');
  }
  if (pack.optimizations.length) {
    L.push('## Automatic optimisations applied');
    L.push('');
    for (const o of pack.optimizations) L.push(`- **${o.title}** — ${o.detail}`);
    L.push('');
  }
  L.push('## Assembly');
  L.push('');
  pack.assembly.stitch.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push('## Run contract');
  L.push('');
  L.push('```sh');
  L.push(...pack.runContract.commands);
  L.push('```');
  L.push('');
  L.push(`Schedule: ${pack.runContract.schedule}`);
  L.push('');
  L.push('---');
  L.push('');
  pack.stages.forEach((st, i) => {
    L.push(`## Stage ${i + 1} — ${st.title}`);
    L.push('');
    L.push(`*${st.purpose}*`);
    L.push('');
    L.push(`Deliverable: \`${st.deliverable}\` · expected output ≤ ${st.budget.maxTokensParam} tokens · ${st.budget.inputTokens} input tokens · temperature ${st.params.temperature}`);
    L.push('');
    L.push('<details><summary>System prompt</summary>');
    L.push('');
    L.push('```text');
    L.push(fenceSafe(st.system));
    L.push('```');
    L.push('</details>');
    L.push('');
    L.push('```text');
    L.push(fenceSafe(st.user));
    L.push('```');
    L.push('');
  });
  L.push('## Repair loop');
  L.push('');
  L.push('```text');
  L.push(fenceSafe(pack.repair.protocol));
  L.push('```');
  L.push('');
  L.push(`> ${pack.limits.note}`);
  L.push('');
  return L.join('\n');
}

/**
 * Shell script that runs the pack against the provider with one curl per stage,
 * pausing to respect the free-tier RPM limit. Keys are read from the environment
 * and never written into the file.
 */
export function packToCurl(pack) {
  const p = pack.provider;
  const L = [];
  L.push('#!/usr/bin/env bash');
  L.push('# Forge-Zero pack runner — generated for ' + pack.model.label);
  L.push('# Usage: FORGE_API_KEY=... ./run-pack.sh [stage-number]');
  L.push('set -euo pipefail');
  L.push('');
  L.push(`API_KEY="\${FORGE_API_KEY:?set FORGE_API_KEY (never commit it)}"`);
  L.push(`BASE_URL="${p?.baseUrl ?? 'https://api.example.com/v1'}"`);
  L.push(`MODEL="${pack.model.id}"`);
  L.push(`SPACING=${Math.max(pack.budget.minSpacingSec, 1)}   # seconds, from the free-tier RPM limit`);
  L.push('OUT_DIR="${OUT_DIR:-./out}"');
  L.push('FROM_STAGE="${1:-1}"');
  L.push('mkdir -p "$OUT_DIR"');
  L.push('');
  if (p?.authHeader === 'x-goog-api-key') {
    L.push('auth=(-H "x-goog-api-key: $API_KEY")');
    L.push('endpoint() { echo "$BASE_URL/models/$1:generateContent"; }');
  } else {
    L.push('auth=(-H "Authorization: Bearer $API_KEY")');
    L.push('endpoint() { echo "$BASE_URL/chat/completions"; }');
  }
  L.push('');
  L.push('run_stage() {');
  L.push('  local n="$1" file="$2"');
  L.push('  if (( n < FROM_STAGE )); then return 0; fi');
  L.push('  echo "[stage $n] $(cat "$file" | head -c 90 | tr -d \'\\n\')… (prompt: $(wc -c < "$file") bytes)"');
  L.push('  jq -n --rawtext --arg model "$MODEL" --argjson mt "$MAXTOK" --argjson t "$TEMP" \'{');
  L.push('    model:$model,');
  L.push('    temperature:$t,');
  L.push('    max_tokens:$mt,');
  L.push('    messages:[{role:"user",content:.}]');
  L.push('  }\' > "$OUT_DIR/req-$n.json"');
  L.push('  curl -sS --fail-with-body -X POST "$(endpoint "$MODEL")" "${auth[@]}" \\');
  L.push('    -H "content-type: application/json" --data @"$OUT_DIR/req-$n.json" \\');
  L.push('    | tee "$OUT_DIR/res-$n.json" | jq -r \'.choices[0].message.content // .candidates[0].content.parts[0].text\' \\');
  L.push('    > "$OUT_DIR/stage-$n.out"');
  L.push('  echo "  -> $OUT_DIR/stage-$n.out"');
  L.push('  sleep "$SPACING"');
  L.push('}');
  L.push('');
  pack.stages.forEach((st, i) => {
    L.push(`cat > "$OUT_DIR/prompt-$i.txt" <<'PROMPT_EOF'`);
    L.push(shellSafe(st.user));
    L.push('PROMPT_EOF');
    L.push(`MAXTOK=${st.budget.maxTokensParam}; TEMP=${st.params.temperature}; run_stage ${i + 1} "$OUT_DIR/prompt-$i.txt"`);
    L.push('');
  });
  L.push('echo "Done. Stitch outputs per the assembly instructions in prompt-pack.md."');
  L.push('');
  return L.join('\n');
}

function fenceSafe(text) {
  return String(text).replace(/^```/gm, '```\u200b');
}

function shellSafe(text) {
  // A quoted heredoc delimiter makes the body literal, but a line that exactly
  // matches the delimiter would still end it early. Neutralise that.
  return String(text).replace(/^PROMPT_EOF$/gm, "PROMPT_E'''OF");
}

export function packToStageFiles(pack) {
  return pack.stages.map((st, i) => ({
    name: `${String(i + 1).padStart(2, '0')}-${st.id.replace(/[^a-z0-9:._-]/gi, '-')}.txt`,
    contents: st.copyText,
  }));
}

export function bundleForDownload(pack) {
  return {
    'prompt-pack.json': JSON.stringify(pack, null, 2),
    'prompt-pack.md': packToMarkdown(pack),
    'run-pack.sh': packToCurl(pack),
    ...Object.fromEntries(packToStageFiles(pack).map((f) => [`stages/${f.name}`, f.contents])),
    'README-runbook.md': runbook(pack),
  };
}

function runbook(pack) {
  return [
    `# Runbook — ${pack.spec.name}`,
    '',
    MODE_LABELS[pack.mode] ?? pack.mode,
    '',
    '1. Pick a stage, copy its prompt, send it to the model (run-pack.sh does this for you).',
    '2. Paste the reply into the project exactly as returned - no trimming, no re-formatting.',
    '3. If the reply ends with a CONTINUE marker, immediately send the continuation prompt.',
    '4. Only after all stages land, open the app / run the tests.',
    '5. On failure, use the repair stage for that stage only. Never re-run earlier stages.',
    '',
    `Daily budget: ${pack.runContract.dailyBudget}. ${pack.runContract.schedule}`,
    '',
  ].join('\n');
}
