use serde_json::Value;

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

#[cfg(test)]
mod tests {
    use super::{PayloadContextInspection, inspect_payload_context};
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
