/**
 * Verbatim host-run system prompts for the keyless `extract`/`observe`/`act`
 * bundles (spec §3 P4, §8; plan Task 10).
 *
 * The CLI NEVER calls a model. These constants are handed to the HOST LLM as
 * part of the extract/observe bundle; the host runs the inference. They are the
 * Stagehand act/extract/observe system prompts, copied verbatim from the
 * reference `bad_research/browse/agent_browser.py:271-299` (see NOTICE).
 *
 * DO NOT edit the wording. Their behaviour is load-bearing for the
 * anti-hallucination contract — in particular EXTRACT_SYSTEM_PROMPT's rule
 * "If a user is attempting to extract links or URLs, you MUST respond with ONLY
 * the IDs of the link elements" is the model-facing half of the ID-grounding
 * that transform.ts enforces structurally in the schema.
 */

export const ACT_SYSTEM_PROMPT =
  'You are helping the user automate the browser by finding elements based on what ' +
  'action the user wants to take on the page. You will be given: 1. a user defined ' +
  'instruction about what action to take on the page 2. a hierarchical accessibility ' +
  'tree showing the semantic structure of the page. The tree is a hybrid of the DOM and ' +
  'the accessibility tree. Return the element that matches the instruction if it exists. ' +
  'Otherwise, return an empty object.'

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

export const OBSERVE_SYSTEM_PROMPT =
  'You are helping the user automate the browser by finding elements based on what the ' +
  'user wants to observe in the page. You will be given: 1. a instruction of elements to ' +
  'observe 2. a hierarchical accessibility tree showing the semantic structure of the ' +
  'page. Return an array of elements that match the instruction if they exist, otherwise ' +
  'return an empty array. When returning elements, include the appropriate method from ' +
  'the supported actions list.'
