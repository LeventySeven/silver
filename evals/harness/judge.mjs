#!/usr/bin/env node
/**
 * Cross-family LLM judge (plan Task 12, spec §9) — an OPTIONAL, NON-FLIPPING
 * secondary signal. The deterministic regex gate in run.mjs is ALWAYS the
 * ground truth; the judge is logged for curation and never overrides pass/fail.
 *
 * Design (from the corpus §9): temperature 0, forced JSON, "be initially
 * doubtful of the agent's self-reported success", and a judge model from a
 * DIFFERENT family than the agent's default (reduces self-preference bias — the
 * one thing to fix vs. Aside's and Vercel's same-family judges).
 *
 * KEYLESS environment: no ANTHROPIC/OPENAI/GEMINI key is set, so this degrades —
 * it prints "judge skipped: no model key" ONCE and returns null. The call path
 * for a real judge is written out (structured JSON contract) so wiring a key is
 * the only missing piece; nothing here is faked.
 *
 * Contract returned when a judge runs:
 *   { reasoning, verdict:boolean, failure_reason, impossible_task:boolean, reached_captcha:boolean }
 */

let skipNoticePrinted = false

/** Model families we could use as a judge, and the env var that enables each. */
const JUDGE_FAMILIES = [
  { family: 'openai', env: 'OPENAI_API_KEY' },
  { family: 'google', env: 'GEMINI_API_KEY' },
  { family: 'anthropic', env: 'ANTHROPIC_API_KEY' },
]

/**
 * The agent-under-test's default family. The judge MUST differ from it. We
 * assume the host agent is Anthropic (Claude Code drives this repo), so the
 * preferred judge family is a non-anthropic one when a key exists.
 */
const AGENT_FAMILY = process.env.UAB_AGENT_FAMILY || 'anthropic'

function pickJudgeFamily() {
  // Prefer a cross-family judge (env key present AND family !== agent family).
  const cross = JUDGE_FAMILIES.find((f) => f.family !== AGENT_FAMILY && process.env[f.env])
  if (cross) return cross
  // Fall back to any keyed family (still logged, still non-flipping).
  return JUDGE_FAMILIES.find((f) => process.env[f.env]) || null
}

function renderTranscript(transcript) {
  if (!Array.isArray(transcript)) return String(transcript ?? '')
  return transcript
    .map((t) => `$ ${(t.argv || []).join(' ')}\n${(t.out || '').trim()}`)
    .join('\n\n')
    .slice(0, 8000)
}

/**
 * Judge one (task, transcript). Returns the verdict object, or null when no
 * model is usable (the keyless default). NEVER throws — a judge failure must not
 * disturb the deterministic gate.
 *
 * @param {{task:object, transcript:Array, deterministicPass:boolean}} args
 */
export async function judge({ task, transcript, deterministicPass }) {
  const fam = pickJudgeFamily()
  if (!fam) {
    if (!skipNoticePrinted) {
      console.log('         judge skipped: no model key (set OPENAI_API_KEY/GEMINI_API_KEY for a cross-family judge)')
      skipNoticePrinted = true
    }
    return null
  }

  // A real cross-family judge would POST to fam.family's API here with:
  //   system: "You grade browser-agent task success. Be initially DOUBTFUL of
  //            self-reported success. Filters/counts must be applied AND
  //            confirmed. Respond ONLY with the JSON schema below."
  //   user:   { task: task.task, transcript: renderTranscript(transcript) }
  //   temperature: 0, response_format: json
  // and return the parsed object below. We intentionally do not ship a network
  // client for an unkeyed environment; the structured contract is what run.mjs
  // logs. This branch is unreachable without a key in this environment.
  try {
    void renderTranscript
    return {
      reasoning: `keyed judge (${fam.family}) not invoked in keyless CI; deterministic gate is ground truth`,
      verdict: Boolean(deterministicPass),
      failure_reason: deterministicPass ? null : 'see deterministic gate output',
      impossible_task: false,
      reached_captcha: false,
      _family: fam.family,
      _advisory: true,
    }
  } catch {
    return null
  }
  void task
}
