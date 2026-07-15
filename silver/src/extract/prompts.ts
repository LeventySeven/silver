/**
 * Verbatim host-run system prompt for the keyless `extract` bundle
 * (spec §3 P4, §8; plan Task 10).
 *
 * The CLI NEVER calls a model. This constant is handed to the HOST LLM as
 * part of the extract bundle; the host runs the inference. It is the Stagehand
 * extract system prompt, copied verbatim from the reference
 * `bad_research/browse/agent_browser.py:271-299` (see NOTICE).
 *
 * DO NOT edit the wording. Their behaviour is load-bearing for the
 * anti-hallucination contract — in particular EXTRACT_SYSTEM_PROMPT's rule
 * "If a user is attempting to extract links or URLs, you MUST respond with ONLY
 * the IDs of the link elements" is the model-facing half of the ID-grounding
 * that transform.ts enforces structurally in the schema.
 */

export const EXTRACT_SYSTEM_PROMPT =
  'You are extracting content on behalf of a user. If a user asks you to extract a ' +
  "'list' of information, or 'all' information, YOU MUST EXTRACT ALL OF THE INFORMATION " +
  'THAT THE USER REQUESTS. You will be given: 1. An instruction 2. A list of DOM ' +
  'elements to extract from. Print the exact text from the DOM elements with all ' +
  'symbols, characters, and endlines as is. Print null or an empty string if no new ' +
  'information is found. ONLY print the content using the print_extracted_data tool ' +
  'provided. If a user is attempting to extract links or URLs, you MUST respond with ' +
  'ONLY the IDs of the link elements. Do not attempt to extract links directly from the ' +
  'text unless absolutely necessary.'
