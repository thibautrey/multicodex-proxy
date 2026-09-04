use serde_json::{Map, Value, json};

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

fn as_non_empty_string(value: Option<&Value>) -> Option<&str> {
    let value = value?.as_str()?;
    (!value.trim().is_empty()).then_some(value.trim())
}

fn should_expose_function_call_name(value: Option<&Value>) -> bool {
    let Some(name) = value.and_then(Value::as_str) else {
        return true;
    };
    !name.trim().to_ascii_lowercase().starts_with("functions.")
}

fn normalized_tool_arguments(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_owned());
    }

    let serialized = serde_json::to_string(value).ok()?;
    (!serialized.trim().is_empty()).then_some(serialized)
}

fn is_valid_chat_tool_call(value: &Value) -> bool {
    let Some(tool_call) = value.as_object() else {
        return false;
    };
    let Some(function) = tool_call
        .get("function")
        .filter(|value| !value.is_null())
        .and_then(Value::as_object)
    else {
        return false;
    };

    as_non_empty_string(function.get("name")).is_some()
        && should_expose_function_call_name(function.get("name"))
        && normalized_tool_arguments(function.get("arguments")).is_some()
}

fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                Value::Object(object) => object.get("text").and_then(Value::as_str),
                _ => None,
            })
            .collect(),
        _ => String::new(),
    }
}

/// Remove paired, case-insensitive `<think>...</think>` sections while
/// preserving unmatched markers. This mirrors the stream bridge's existing
/// JavaScript behavior without bringing a regex engine into the native core.
fn strip_think_blocks(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut cursor = 0;
    let mut output = String::new();

    while let Some(relative_start) = lower[cursor..].find("<think>") {
        let start = cursor + relative_start;
        output.push_str(&text[cursor..start]);
        let content_start = start + "<think>".len();
        let Some(relative_end) = lower[content_start..].find("</think>") else {
            output.push_str(&text[start..]);
            return output;
        };
        cursor = content_start + relative_end + "</think>".len();
    }

    output.push_str(&text[cursor..]);
    output
}

fn response_usage_from_chat_usage(value: Option<&Value>) -> Option<Value> {
    let usage = value?;
    // JavaScript's typeof [] is "object" as well. Arrays cannot expose the
    // named fields below, so they naturally fall back to zeroes.
    if !(usage.is_object() || usage.is_array()) {
        return None;
    }

    let input = usage
        .get("prompt_tokens")
        .filter(|value| !value.is_null())
        .or_else(|| usage.get("input_tokens").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(0));
    let output = usage
        .get("completion_tokens")
        .filter(|value| !value.is_null())
        .or_else(|| usage.get("output_tokens").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(0));
    let total = usage
        .get("total_tokens")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| match (&input, &output) {
            (Value::Number(input), Value::Number(output)) => {
                if let (Some(input), Some(output)) = (input.as_u64(), output.as_u64()) {
                    json!(input.saturating_add(output))
                } else if let (Some(input), Some(output)) = (input.as_i64(), output.as_i64()) {
                    json!(input.saturating_add(output))
                } else {
                    let total = input.as_f64().unwrap_or(0.0) + output.as_f64().unwrap_or(0.0);
                    json!(total)
                }
            }
            _ => json!(0),
        });

    Some(json!({
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": total,
    }))
}

fn response_output_from_chat_message(message: &Value) -> Vec<Value> {
    let raw_content = message.get("content");
    let text = strip_think_blocks(&content_text(raw_content))
        .trim_start()
        .to_owned();
    let mut output = Vec::new();

    if !text.is_empty() {
        output.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text}],
        }));
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for tool_call in tool_calls {
            if !is_valid_chat_tool_call(tool_call) {
                continue;
            }
            let Some(tool_call_object) = tool_call.as_object() else {
                continue;
            };
            let Some(function) = tool_call_object.get("function").and_then(Value::as_object) else {
                continue;
            };
            let Some(name) = function.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(arguments) = normalized_tool_arguments(function.get("arguments")) else {
                continue;
            };

            let mut function_call = Map::new();
            if let Some(id) = tool_call_object.get("id").filter(|value| !value.is_null()) {
                function_call.insert("id".to_owned(), id.clone());
                function_call.insert("call_id".to_owned(), id.clone());
            }
            function_call.insert("type".to_owned(), json!("function_call"));
            function_call.insert("name".to_owned(), json!(name));
            function_call.insert("arguments".to_owned(), json!(arguments));
            output.push(Value::Object(function_call));
        }
    }

    if output.is_empty() {
        output.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": ""}],
        }));
    }

    output
}

/// Convert a normalized Chat Completions object to the Responses object used
/// by the proxy's compatibility layer.
///
/// The JavaScript sanitizer and empty-output guard remain the authority for
/// the full client-facing contract. This core owns only the deterministic
/// protocol projection; response and missing tool-call identifiers are passed
/// in by the caller so the native path cannot silently change identifier
/// semantics.
pub fn chat_completion_to_response(
    chat: &Value,
    fallback_model: &str,
    response_id: &str,
    created_at: i64,
) -> Value {
    let empty = Value::Null;
    let choice = chat
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .unwrap_or(&empty);
    let message = choice
        .get("message")
        .filter(|value| value.is_object())
        .unwrap_or(&empty);

    let model = chat
        .get("model")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!(fallback_model));
    let created = chat
        .get("created")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!(created_at));
    let usage = response_usage_from_chat_usage(chat.get("usage"));

    let mut response = Map::new();
    response.insert("id".to_owned(), json!(response_id));
    response.insert("object".to_owned(), json!("response"));
    response.insert("created_at".to_owned(), created);
    response.insert("model".to_owned(), model);
    response.insert("status".to_owned(), json!("completed"));
    response.insert(
        "output".to_owned(),
        Value::Array(response_output_from_chat_message(message)),
    );
    if let Some(usage) = usage {
        response.insert("usage".to_owned(), usage);
    }

    Value::Object(response)
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

/// Convert normalized Chat Completions JSON without crossing the N-API
/// boundary once per output item. Invalid JSON remains an argument error so
/// the TypeScript caller can use its reference implementation.
#[napi(js_name = "convertChatCompletionToResponseJson")]
pub fn convert_chat_completion_to_response_json(
    payload: Buffer,
    fallback_model: String,
    response_id: String,
    created_at: i64,
) -> napi::Result<String> {
    let value: Value = serde_json::from_slice(payload.as_ref()).map_err(|error| {
        Error::new(Status::InvalidArg, format!("Invalid JSON payload: {error}"))
    })?;

    serde_json::to_string(&chat_completion_to_response(
        &value,
        &fallback_model,
        &response_id,
        created_at,
    ))
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Serialization failed: {error}"),
        )
    })
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
    use super::{
        PayloadContextInspection, chat_completion_to_response, classify_sse_frame_type,
        inspect_payload_context,
    };
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

    #[test]
    fn matches_every_shared_protocol_conversion_fixture() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/protocol-conversion-cases.json"))
                .expect("shared protocol conversion fixtures must be valid JSON");

        for fixture in fixtures {
            let actual = chat_completion_to_response(
                &fixture["chat"],
                fixture["fallbackModel"].as_str().expect("fallback model"),
                fixture["responseId"].as_str().expect("response id"),
                fixture["createdAt"].as_i64().expect("created at"),
            );
            assert_eq!(actual, fixture["expected"], "{}", fixture["name"]);
        }
    }
}
