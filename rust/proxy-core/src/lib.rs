use serde_json::Value;

use napi::{Error, Status, bindgen_prelude::Buffer};
use napi_derive::napi;

const FAST_SSE_EVENT_PREFIXES: &[&str] = &["response.reasoning", "response.refusal"];

fn is_fast_sse_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.output_text.delta" | "response.output_text.done"
    ) || FAST_SSE_EVENT_PREFIXES
        .iter()
        .any(|prefix| event_type.starts_with(prefix))
}

/// Extract the first JSON `type`-like property using the same deliberately
/// conservative syntax accepted by the TypeScript fast path. This is not a
/// JSON parser: frames that do not match the exact SSE shape return `None` and
/// remain on the reference parser.
fn json_type_property(payload: &str) -> Option<&str> {
    let marker = "\"type\"";
    let mut search_from = 0;

    while search_from < payload.len() {
        let relative = payload[search_from..].find(marker)?;
        let marker_start = search_from + relative;
        let mut remainder = &payload[marker_start + marker.len()..];
        remainder = remainder.trim_start();
        if let Some(after_colon) = remainder.strip_prefix(':') {
            let after_colon = after_colon.trim_start();
            if let Some(after_quote) = after_colon.strip_prefix('"') {
                let end = after_quote.find('"')?;
                if end > 0 {
                    return Some(&after_quote[..end]);
                }
            }
        }
        search_from = marker_start + marker.len();
    }

    None
}

/// Classify only the high-frequency SSE frames whose event type can be used
/// without materializing the JSON event. The return value is empty when the
/// caller must use the full parser.
pub fn classify_sse_frame_type(frame: &str) -> Option<&str> {
    let mut event_type: Option<&str> = None;
    let mut data_payload: Option<&str> = None;

    for raw_line in frame.split('\n') {
        let line = raw_line.trim();
        if let Some(value) = line.strip_prefix("event:") {
            event_type = Some(value.trim());
        } else if let Some(value) = line.strip_prefix("data:") {
            if data_payload.is_some() {
                return None;
            }
            data_payload = Some(value.trim());
        }
    }

    let event_type = event_type?;
    let data_payload = data_payload?;
    if !data_payload.starts_with('{') || !data_payload.ends_with('}') {
        return None;
    }

    let payload_type = json_type_property(data_payload)?;
    if payload_type != event_type || !is_fast_sse_event_type(event_type) {
        return None;
    }

    Some(event_type)
}

/// Stable, serialization-friendly result of the request inspection phase.
///
/// The fields intentionally mirror the existing TypeScript contract. Routing
/// and provider code should depend on this small result rather than on the
/// request representation itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadContextInspection {
    pub has_image: bool,
    pub compaction_item_count: usize,
    pub latest_compaction_index: i64,
}

/// JavaScript-facing representation of [`PayloadContextInspection`].
///
/// The N-API object deliberately contains only the three scalar values needed
/// by the router. It does not expose the parsed request or retain any payload
/// bytes after the synchronous call returns.
#[napi(object)]
pub struct NativePayloadContextInspection {
    pub has_image: bool,
    pub compaction_item_count: i64,
    pub latest_compaction_index: i64,
}

impl Default for PayloadContextInspection {
    fn default() -> Self {
        Self {
            has_image: false,
            compaction_item_count: 0,
            latest_compaction_index: -1,
        }
    }
}

fn type_contains_image(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| value.contains("image"))
}

/// Inspects the JSON request shape used by Responses and Chat Completions.
///
/// This is deliberately limited to the current router's observable contract:
/// it does not normalize, mutate, or retain request content.
pub fn inspect_payload_context(payload: &Value) -> PayloadContextInspection {
    let mut inspection = PayloadContextInspection::default();

    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for message in messages {
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for part in content {
                    inspection.has_image |= type_contains_image(part);
                }
            }
        }
    }

    if let Some(input) = payload.get("input").and_then(Value::as_array) {
        for (index, item) in input.iter().enumerate() {
            inspection.has_image |= type_contains_image(item);

            if item.get("type").and_then(Value::as_str) == Some("compaction") {
                inspection.compaction_item_count += 1;
                inspection.latest_compaction_index = index as i64;
            }

            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    inspection.has_image |= type_contains_image(part);
                }
            }
        }
    }

    inspection
}

impl From<PayloadContextInspection> for NativePayloadContextInspection {
    fn from(value: PayloadContextInspection) -> Self {
        Self {
            has_image: value.has_image,
            compaction_item_count: value.compaction_item_count as i64,
            latest_compaction_index: value.latest_compaction_index,
        }
    }
}

/// Inspect UTF-8 JSON bytes received from Node without serializing the object
/// across the language boundary.
///
/// The function is synchronous because the operation is CPU-bound and small;
/// callers invoke it from the body-parser's existing synchronous verification
/// hook. Invalid JSON is reported as an `InvalidArg` N-API exception so the
/// TypeScript caller can keep its existing implementation as a safe fallback.
#[napi(js_name = "inspectPayloadContextJson")]
pub fn inspect_payload_context_json(
    payload: Buffer,
) -> napi::Result<NativePayloadContextInspection> {
    let value: Value = serde_json::from_slice(payload.as_ref()).map_err(|error| {
        Error::new(Status::InvalidArg, format!("Invalid JSON payload: {error}"))
    })?;

    Ok(inspect_payload_context(&value).into())
}

/// Classify a high-frequency SSE frame without parsing its JSON payload.
///
/// An empty string means that the frame is not eligible for the fast path and
/// must be inspected by the caller's full JSON parser. The function is kept
/// synchronous and allocation-light because it is called from the stream
/// relay's hot loop only for frames above the native rollout threshold.
#[napi(js_name = "classifySseFrame")]
pub fn classify_sse_frame(frame: String) -> napi::Result<String> {
    Ok(classify_sse_frame_type(&frame)
        .unwrap_or_default()
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::{PayloadContextInspection, classify_sse_frame_type, inspect_payload_context};
    use serde_json::{Value, json};

    #[test]
    fn matches_every_shared_migration_fixture() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/payload-inspection-cases.json"))
                .expect("shared payload inspection fixtures must be valid JSON");

        for fixture in fixtures {
            let name = fixture["name"].as_str().expect("fixture name");
            let actual = inspect_payload_context(&fixture["payload"]);
            let expected = &fixture["expected"];
            assert_eq!(
                actual.has_image,
                expected["hasImage"].as_bool().expect("hasImage"),
                "{name}"
            );
            assert_eq!(
                actual.compaction_item_count,
                expected["compactionItemCount"].as_u64().expect("count") as usize,
                "{name}"
            );
            assert_eq!(
                actual.latest_compaction_index,
                expected["latestCompactionIndex"].as_i64().expect("index"),
                "{name}"
            );
        }
    }

    #[test]
    fn classifies_only_the_safe_sse_fast_path() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/sse-fast-path-cases.json"))
                .expect("shared SSE fixtures must be valid JSON");

        for fixture in fixtures {
            let frame = fixture["frame"].as_str().expect("fixture frame");
            let expected = fixture["expected"].as_str();
            assert_eq!(
                classify_sse_frame_type(frame),
                expected,
                "{}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn keeps_the_responses_image_and_compaction_contract_stable() {
        let payload = json!({
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "before"}]},
                {"type": "compaction", "encrypted_content": "opaque-one"},
                {"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA"}]},
                {"type": "compaction", "encrypted_content": "opaque-two"}
            ]
        });

        assert_eq!(
            inspect_payload_context(&payload),
            PayloadContextInspection {
                has_image: true,
                compaction_item_count: 2,
                latest_compaction_index: 3,
            }
        );
    }

    #[test]
    fn recognizes_item_and_nested_content_images() {
        let payload = json!({
            "input": [
                {"type": "computer_screenshot_image", "data": "opaque"},
                {"content": [{"type": "custom_image_part"}]}
            ]
        });

        assert!(inspect_payload_context(&payload).has_image);
    }

    #[test]
    fn recognizes_chat_completions_images_without_compaction_data() {
        let payload = json!({
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "https://example/image"}}
                ]
            }]
        });

        assert_eq!(
            inspect_payload_context(&payload),
            PayloadContextInspection {
                has_image: true,
                compaction_item_count: 0,
                latest_compaction_index: -1,
            }
        );
    }

    #[test]
    fn ignores_malformed_or_scalar_payload_branches() {
        for payload in [json!(null), json!("text"), json!(42), json!([])] {
            assert_eq!(
                inspect_payload_context(&payload),
                PayloadContextInspection::default()
            );
        }

        let malformed = json!({"input": {}, "messages": {}});
        assert_eq!(
            inspect_payload_context(&malformed),
            PayloadContextInspection::default()
        );
    }

    #[test]
    fn counts_every_compaction_item_and_reports_the_last_array_index() {
        let payload = json!({
            "input": [
                {"type": "compaction"},
                {"type": "input_text", "content": [{"type": "text"}]},
                {"type": "compaction"},
                {"type": "compaction"}
            ]
        });

        assert_eq!(
            inspect_payload_context(&payload),
            PayloadContextInspection {
                has_image: false,
                compaction_item_count: 3,
                latest_compaction_index: 3,
            }
        );
    }
}
