//! Keyless, ID-grounded `extract` primitives (Silver Delta 1).
//!
//! THE MOAT. Before the host LLM ever sees an extract schema, we swap every
//! URL-bearing field for an *element-ID* field constrained to `^\d+-\d+$`. A
//! model asked to fill an ID-pattern field literally cannot emit a fabricated
//! URL as free text — it can only emit an ID that maps to a real DOM node via
//! the daemon-retained value map. Fabricated URLs become STRUCTURALLY
//! impossible rather than merely discouraged.
//!
//! This module is a Rust port of the TS reference implementation at
//! `skill/agent-browser/src/extract/{transform,resolve,prompts}.ts`. It is
//! 100% KEYLESS: it only transforms JSON and strings. No model, no network.
//!
//! The walk is tolerant of BOTH real JSON Schema (`{type,properties,items,
//! format}`) AND the terse "shape" shorthand a caller may pass
//! (`{"links":[{"title":"string","url":"string"}]}`), so either form produces
//! the same ID-grounded contract.

use std::collections::{BTreeSet, HashMap};

use serde_json::{json, Map, Value};

/// The element-ID pattern the host model is constrained to emit for URL fields.
pub const ID_PATTERN: &str = r"^\d+-\d+$";

/// Verbatim host-run EXTRACT system prompt (copied from `prompts.ts`). The
/// wording is load-bearing for the anti-hallucination contract — in particular
/// the rule "you MUST respond with ONLY the IDs of the link elements" is the
/// model-facing half of the ID-grounding that `transform_schema` enforces
/// structurally in the schema. DO NOT edit the wording.
pub const EXTRACT_SYSTEM_PROMPT: &str = "You are extracting content on behalf of a user. If a user asks you to extract a \
'list' of information, or 'all' information, YOU MUST EXTRACT ALL OF THE INFORMATION \
THAT THE USER REQUESTS. You will be given: 1. An instruction 2. A list of DOM \
elements to extract from. Print the exact text from the DOM elements with all \
symbols, characters, and endlines as is. Print null or an empty string if no new \
information is found. ONLY print the content using the print_extracted_data tool \
provided. If a user is attempting to extract links or URLs, you MUST respond with \
ONLY the IDs of the link elements. Do not attempt to extract links directly from the \
text unless absolutely necessary.";

/// A freshly-minted ID-field schema (fresh object per call — never shared).
fn id_field() -> Value {
    json!({
        "type": "string",
        "pattern": ID_PATTERN,
        "description": "the element ID of the link, e.g. 0-18372",
    })
}

/// Field names (case-insensitive) treated as URL-bearing regardless of type.
fn is_url_name(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "url" | "href" | "link")
}

/// A `{type:"string", format:"uri"|"url"}` schema leaf.
fn is_uri_string_schema(node: &Value) -> bool {
    let Value::Object(m) = node else { return false };
    if m.get("type").and_then(|v| v.as_str()) != Some("string") {
        return false;
    }
    matches!(
        m.get("format").and_then(|v| v.as_str()),
        Some("uri") | Some("url")
    )
}

/// A property named url/href/link is URL-bearing — but only collapse it to an
/// ID when it is a string-ish LEAF. A container named `url` (object/array) is
/// recursed into instead, so we never turn a whole subtree into a single ID.
fn name_is_url_leaf(name_hint: Option<&str>, node: &Value) -> bool {
    let Some(name) = name_hint else { return false };
    if !is_url_name(name) {
        return false;
    }
    match node {
        // Shorthand leaf, e.g. `"url": "string"`, or an explicit null.
        Value::String(_) | Value::Null => true,
        Value::Object(m) => {
            // A container (has properties/items) is never a url leaf.
            if m.contains_key("properties") || m.contains_key("items") {
                return false;
            }
            match m.get("type").and_then(|v| v.as_str()) {
                Some("string") => true,
                Some(_) => false, // typed non-string / container
                // No type: an empty `{}` is a leaf; a populated shorthand map is
                // a container and must be recursed into, not collapsed.
                None => m.is_empty(),
            }
        }
        // number / bool / array named "url" — not a url string leaf.
        _ => false,
    }
}

/// Deep-walk a schema (JSON Schema OR shorthand), returning a NEW schema with
/// every URL-bearing field replaced by the ID-pattern field, plus the
/// dot-joined paths of every replaced field. Array items are addressed with
/// `*`. The input is never mutated.
pub fn transform_schema(schema: &Value) -> (Value, Vec<String>) {
    let mut paths: Vec<String> = Vec::new();
    let transformed = walk(schema, &[], None, &mut paths);
    // De-duplicate paths (shorthand arrays with >1 example element repeat `*`).
    let mut seen = BTreeSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    (transformed, paths)
}

fn walk(node: &Value, path: &[String], name_hint: Option<&str>, out: &mut Vec<String>) -> Value {
    // 1. Does this node itself become an element-ID field?
    if is_uri_string_schema(node) || name_is_url_leaf(name_hint, node) {
        out.push(path.join("."));
        return id_field();
    }

    match node {
        Value::Object(map) => {
            // 2. JSON Schema object with `type:"object"` + `properties`.
            if map.get("type").and_then(|v| v.as_str()) == Some("object") {
                if let Some(props) = map.get("properties").and_then(|p| p.as_object()) {
                    let mut new_props = Map::new();
                    for (key, val) in props {
                        let mut child_path = path.to_vec();
                        child_path.push(key.clone());
                        new_props.insert(key.clone(), walk(val, &child_path, Some(key), out));
                    }
                    let mut new_node = map.clone();
                    new_node.insert("properties".to_string(), Value::Object(new_props));
                    return Value::Object(new_node);
                }
            }

            // 3. JSON Schema array with `type:"array"` + `items`.
            if map.get("type").and_then(|v| v.as_str()) == Some("array") {
                if let Some(items) = map.get("items") {
                    let mut child_path = path.to_vec();
                    child_path.push("*".to_string());
                    let new_items = walk(items, &child_path, None, out);
                    let mut new_node = map.clone();
                    new_node.insert("items".to_string(), new_items);
                    return Value::Object(new_node);
                }
            }

            // 4. Shorthand object (a plain map of field → shape, no schema
            //    `type` key). Every key is a field; recurse with its name hint.
            if !map.contains_key("type") && !map.is_empty() {
                let mut new_map = Map::new();
                for (key, val) in map {
                    let mut child_path = path.to_vec();
                    child_path.push(key.clone());
                    new_map.insert(key.clone(), walk(val, &child_path, Some(key), out));
                }
                return Value::Object(new_map);
            }

            // 5. Schema leaf that isn't URL-bearing — passed through unchanged.
            node.clone()
        }

        // 6. Shorthand array (a list): transform each element shape with `*`.
        Value::Array(arr) => {
            let mut child_path = path.to_vec();
            child_path.push("*".to_string());
            Value::Array(arr.iter().map(|el| walk(el, &child_path, None, out)).collect())
        }

        // 7. Primitive leaf (type marker string, number, bool) — passthrough.
        _ => node.clone(),
    }
}

/// Default cardinality to a CONTAINER (`list[T]`). A bare object schema tends
/// to make the model collapse N page results into 1; wrapping it in an array
/// forces the model to return every match. Already a container (or a
/// primitive) → returned unchanged. Mirrors `ensureContainer` in transform.ts.
pub fn ensure_container(schema: Value) -> Value {
    match &schema {
        Value::Array(_) => schema, // already a list
        Value::Object(map) => match map.get("type").and_then(|v| v.as_str()) {
            Some("array") => schema,                          // already a container
            Some("object") => json!({ "type": "array", "items": schema }),
            Some(_) => schema, // typed primitive schema — leave as-is
            None => Value::Array(vec![schema]), // bare shorthand object → wrap
        },
        _ => schema, // primitive
    }
}

/// Assemble the extract bundle the daemon returns. The host runs inference over
/// `id_transformed_schema` + `prompt` + `snapshot_with_ids`. The daemon NEVER
/// calls a model. `url_field_paths` is retained for the caller's information;
/// `extract resolve` reverse-maps by walking the whole result, so it does not
/// depend on the paths being exhaustive.
pub fn build_bundle(
    schema: &Value,
    snapshot_with_ids: &str,
    instruction: Option<&str>,
    generation: u64,
    ref_count: usize,
) -> Value {
    let contained = ensure_container(schema.clone());
    let (transformed, url_field_paths) = transform_schema(&contained);
    let prompt = match instruction {
        Some(instr) if !instr.trim().is_empty() => {
            format!("{}\n\nInstruction: {}", EXTRACT_SYSTEM_PROMPT, instr)
        }
        _ => EXTRACT_SYSTEM_PROMPT.to_string(),
    };
    json!({
        "id_transformed_schema": transformed,
        "prompt": prompt,
        "snapshot_with_ids": snapshot_with_ids,
        "url_field_paths": url_field_paths,
        "generation": generation,
        "ref_count": ref_count,
    })
}

/// True iff `s` is exactly the element-ID shape `^\d+-\d+$`.
pub fn matches_id_pattern(s: &str) -> bool {
    let mut parts = s.split('-');
    let (Some(a), Some(b), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && a.bytes().all(|c| c.is_ascii_digit())
        && b.bytes().all(|c| c.is_ascii_digit())
}

/// Reverse-map element IDs back to real values, walking the ENTIRE result. Any
/// string matching `^\d+-\d+$` is replaced by its mapped value; an ID absent
/// from the value map becomes `null` (never `""`) and is recorded in `unknown`
/// so the caller can emit a loud warning. Non-ID values are left untouched. The
/// input is never mutated.
pub fn resolve_ids(node: &Value, value_map: &HashMap<String, String>) -> (Value, Vec<String>) {
    let mut unknown = BTreeSet::new();
    let resolved = resolve_walk(node, value_map, &mut unknown);
    (resolved, unknown.into_iter().collect())
}

fn resolve_walk(
    node: &Value,
    value_map: &HashMap<String, String>,
    unknown: &mut BTreeSet<String>,
) -> Value {
    match node {
        Value::String(s) if matches_id_pattern(s) => match value_map.get(s) {
            Some(v) => Value::String(v.clone()),
            None => {
                unknown.insert(s.clone());
                Value::Null
            }
        },
        Value::Array(arr) => {
            Value::Array(arr.iter().map(|x| resolve_walk(x, value_map, unknown)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve_walk(v, value_map, unknown)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Rewrite a rendered accessibility snapshot so each ref-bearing node cites a
/// stable numeric element ID (`<frameOrdinal>-<backendNodeId>`) instead of the
/// `@eN` ref, and STRIP the raw `url=<href>` attribute so the model can only
/// cite IDs, never a real URL. `ref_to_id` maps `eN` → the numeric ID.
///
/// The transform relies on the renderer's guaranteed attribute order: for a
/// link, `url=` is always the LAST attribute inside the `[...]` block and is
/// always immediately preceded by `ref=eN`. So after each `ref=eN` token the
/// only possibilities are `]` (no url) or `, url=<value>]`. A URL never
/// contains `, ` (comma+space) because spaces are percent-encoded, making the
/// strip unambiguous.
pub fn to_id_snapshot(text: &str, ref_to_id: &HashMap<String, String>) -> String {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        if text[i..].starts_with("ref=e") {
            // Parse the digit run after "ref=e".
            let digits_start = i + 5;
            let mut j = digits_start;
            while j < len && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > digits_start {
                let ref_id = &text[i + 4..j]; // "eN"
                match ref_to_id.get(ref_id) {
                    Some(numeric_id) => {
                        out.push_str("id=");
                        out.push_str(numeric_id);
                    }
                    None => out.push_str(&text[i..j]), // unknown ref — leave as-is
                }
                i = j;
                // Strip a trailing `, url=...` up to the closing `]`.
                if text[i..].starts_with(", url=") {
                    if let Some(close_rel) = text[i..].find(']') {
                        i += close_rel; // resume at the `]` (kept)
                    }
                }
                continue;
            }
        }
        // Default: copy one whole UTF-8 char.
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shorthand_url_field_becomes_id_pattern() {
        let schema = json!({ "links": [{ "title": "string", "url": "string" }] });
        let contained = ensure_container(schema);
        let (transformed, paths) = transform_schema(&contained);
        // The container wrap makes the top level a list.
        assert!(transformed.is_array());
        // Drill into the transformed url field.
        let url_field =
            &transformed[0]["links"][0]["url"];
        assert_eq!(url_field["pattern"], ID_PATTERN);
        assert_eq!(url_field["type"], "string");
        // title stays a plain shorthand string.
        assert_eq!(transformed[0]["links"][0]["title"], json!("string"));
        // A path was recorded for the url field.
        assert!(paths.iter().any(|p| p.ends_with("url")));
    }

    #[test]
    fn test_json_schema_uri_format_becomes_id() {
        let schema = json!({
            "type": "object",
            "properties": {
                "homepage": { "type": "string", "format": "uri" },
                "name": { "type": "string" }
            }
        });
        let contained = ensure_container(schema);
        let (transformed, paths) = transform_schema(&contained);
        // object was wrapped into an array.
        assert_eq!(transformed["type"], "array");
        let props = &transformed["items"]["properties"];
        assert_eq!(props["homepage"]["pattern"], ID_PATTERN);
        assert_eq!(props["name"]["type"], "string");
        assert!(props["name"].get("pattern").is_none());
        assert!(paths.contains(&"*.homepage".to_string()));
    }

    #[test]
    fn test_named_container_not_collapsed() {
        // A property literally named "link" but which is an object must be
        // recursed into, not collapsed to a single ID.
        let schema = json!({
            "type": "object",
            "properties": {
                "link": {
                    "type": "object",
                    "properties": { "href": { "type": "string", "format": "uri" } }
                }
            }
        });
        let (transformed, _) = transform_schema(&schema);
        // link stays an object; its href is the ID field.
        assert_eq!(transformed["properties"]["link"]["type"], "object");
        assert_eq!(
            transformed["properties"]["link"]["properties"]["href"]["pattern"],
            ID_PATTERN
        );
    }

    #[test]
    fn test_matches_id_pattern() {
        assert!(matches_id_pattern("0-18372"));
        assert!(matches_id_pattern("12-3"));
        assert!(!matches_id_pattern("e5"));
        assert!(!matches_id_pattern("https://example.com"));
        assert!(!matches_id_pattern("0-"));
        assert!(!matches_id_pattern("-5"));
        assert!(!matches_id_pattern("0-1-2"));
        assert!(!matches_id_pattern("abc"));
    }

    #[test]
    fn test_resolve_ids_maps_and_flags_unknown() {
        let mut map = HashMap::new();
        map.insert("0-1".to_string(), "https://example.com/a".to_string());
        let input = json!([
            { "title": "A", "url": "0-1" },
            { "title": "B", "url": "9-9" },
            { "title": "C", "url": "not-an-id" }
        ]);
        let (resolved, unknown) = resolve_ids(&input, &map);
        assert_eq!(resolved[0]["url"], "https://example.com/a");
        assert_eq!(resolved[1]["url"], Value::Null); // unknown → loud null
        assert_eq!(resolved[2]["url"], "not-an-id"); // non-ID untouched
        assert_eq!(unknown, vec!["9-9".to_string()]);
    }

    #[test]
    fn test_to_id_snapshot_replaces_ref_and_strips_url() {
        let mut ref_to_id = HashMap::new();
        ref_to_id.insert("e1".to_string(), "0-42".to_string());
        ref_to_id.insert("e2".to_string(), "0-99".to_string());
        let text = "- link \"Example\" [ref=e1, url=https://example.com/]\n  - button \"Go\" [ref=e2]\n";
        let out = to_id_snapshot(text, &ref_to_id);
        assert!(out.contains("[id=0-42]"), "got: {out}");
        assert!(!out.contains("url="), "raw href must be stripped: {out}");
        assert!(out.contains("[id=0-99]"));
        assert!(!out.contains("ref=e"));
    }

    #[test]
    fn test_to_id_snapshot_preserves_leading_attrs() {
        let mut ref_to_id = HashMap::new();
        ref_to_id.insert("e1".to_string(), "0-7".to_string());
        let text = "- radio \"Single\" [checked=false, ref=e1, url=https://x/y]\n";
        let out = to_id_snapshot(text, &ref_to_id);
        assert!(out.contains("[checked=false, id=0-7]"), "got: {out}");
        assert!(!out.contains("url="));
    }

    #[test]
    fn test_ensure_container_wraps_bare_object() {
        let schema = json!({ "type": "object", "properties": {} });
        assert_eq!(ensure_container(schema)["type"], "array");
        let list = json!([{ "a": "b" }]);
        assert!(ensure_container(list).is_array());
    }
}
