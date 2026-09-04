//! Native HTTP edge for the `/v1` API.
//!
//! This crate deliberately owns the public inference boundary.  The Node
//! process is a control-plane peer (admin UI, OAuth and background tasks), not
//! an intermediate hop for inference.  Keeping the edge in one process also
//! means request bytes, upstream bytes and SSE frames do not cross a JS/native
//! boundary on the hot path.

use async_stream::stream;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{
        HeaderMap, Method, Request, StatusCode,
        header::{self, HeaderName, HeaderValue},
    },
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    convert::Infallible,
    io::{Cursor, Read},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tokio::{
    fs,
    sync::{Mutex, RwLock},
    time::timeout,
};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const PUBLIC_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "request-id",
    "openai-request-id",
    "anthropic-request-id",
];

#[derive(Clone, Debug)]
pub struct EdgeConfig {
    pub listen_host: String,
    pub listen_port: u16,
    pub node_control_plane_url: String,
    pub store_path: PathBuf,
    pub jobs_path: PathBuf,
    pub trace_path: Option<PathBuf>,
    pub request_body_limit: usize,
    pub realtime_body_limit: usize,
    pub upstream_timeout: Duration,
    pub max_account_retry_attempts: usize,
    pub idempotency_ttl: Duration,
    pub idempotency_max_response_bytes: usize,
    pub chatgpt_base_url: String,
    pub mistral_base_url: String,
    pub mistral_upstream_path: String,
    pub mistral_compact_upstream_path: String,
    pub zai_base_url: String,
    pub zai_upstream_path: String,
    pub zai_compact_upstream_path: String,
    pub xai_base_url: String,
    pub xai_responses_path: String,
    pub xai_chat_completions_path: String,
    pub realtime_provider: String,
    pub realtime_webrtc_call_url: Option<String>,
    pub proxy_models: Vec<String>,
    pub admin_token: String,
    pub configured_api_keys: Vec<(String, String)>,
    pub internal_job_token: Option<String>,
}

impl Default for EdgeConfig {
    fn default() -> Self {
        Self {
            listen_host: "0.0.0.0".to_owned(),
            listen_port: 1455,
            node_control_plane_url: "http://127.0.0.1:1456".to_owned(),
            store_path: PathBuf::from("/data/accounts.json"),
            jobs_path: PathBuf::from("/data/v1-edge-jobs.json"),
            trace_path: None,
            request_body_limit: 100 * 1024 * 1024,
            realtime_body_limit: 2 * 1024 * 1024,
            upstream_timeout: Duration::from_secs(10 * 60),
            max_account_retry_attempts: 10,
            idempotency_ttl: Duration::from_secs(5 * 60),
            idempotency_max_response_bytes: 1024 * 1024,
            chatgpt_base_url: "https://chatgpt.com".to_owned(),
            mistral_base_url: "https://api.mistral.ai".to_owned(),
            mistral_upstream_path: "/v1/responses".to_owned(),
            mistral_compact_upstream_path: "/v1/responses/compact".to_owned(),
            zai_base_url: "https://api.z.ai".to_owned(),
            zai_upstream_path: "/api/coding/paas/v4/chat/completions".to_owned(),
            zai_compact_upstream_path: "/api/coding/paas/v4/chat/completions".to_owned(),
            xai_base_url: "https://cli-chat-proxy.grok.com/v1".to_owned(),
            xai_responses_path: "/responses".to_owned(),
            xai_chat_completions_path: "/chat/completions".to_owned(),
            realtime_provider: "openai".to_owned(),
            realtime_webrtc_call_url: None,
            proxy_models: vec![
                "gpt-5.3-codex".to_owned(),
                "gpt-5.2-codex".to_owned(),
                "gpt-5-codex".to_owned(),
            ],
            admin_token: String::new(),
            configured_api_keys: Vec::new(),
            internal_job_token: None,
        }
    }
}

impl EdgeConfig {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let listen_port = env("V1_EDGE_PORT")
            .or_else(|| env("PORT"))
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(defaults.listen_port);
        let listen_host = env("V1_EDGE_HOST")
            .or_else(|| env("HOST"))
            .unwrap_or(defaults.listen_host.clone());
        let store_path = env("V1_EDGE_STORE_PATH")
            .or_else(|| env("STORE_PATH"))
            .map(PathBuf::from)
            .unwrap_or(defaults.store_path.clone());
        let jobs_path = env("V1_EDGE_JOBS_PATH")
            .or_else(|| env("JOBS_DB_PATH"))
            .map(PathBuf::from)
            .unwrap_or_else(|| store_path.with_file_name("v1-edge-jobs.json"));
        let request_body_limit = env("REQUEST_BODY_LIMIT")
            .map(|v| parse_byte_limit(&v))
            .unwrap_or(defaults.request_body_limit);
        let configured_api_keys = parse_configured_api_keys(
            env("PROXY_API_KEY").as_deref().unwrap_or_default(),
            env("PROXY_API_KEYS").as_deref().unwrap_or_default(),
        )
        .unwrap_or_default();
        let proxy_models = env("PROXY_MODELS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty())
            .unwrap_or(defaults.proxy_models.clone());
        let timeout_ms = env("V1_EDGE_UPSTREAM_TIMEOUT_MS")
            .or_else(|| env("REALTIME_REQUEST_TIMEOUT_MS"))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(defaults.upstream_timeout.as_millis() as u64);
        let realtime_url = env("REALTIME_WEBRTC_CALL_URL");
        Self {
            listen_host,
            listen_port,
            node_control_plane_url: env("NODE_CONTROL_PLANE_URL")
                .unwrap_or(defaults.node_control_plane_url),
            store_path,
            jobs_path,
            trace_path: env("TRACE_FILE_PATH").map(PathBuf::from),
            request_body_limit: request_body_limit.max(1),
            realtime_body_limit: 2 * 1024 * 1024,
            upstream_timeout: Duration::from_millis(timeout_ms.max(1)),
            max_account_retry_attempts: env("MAX_ACCOUNT_RETRY_ATTEMPTS")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.max_account_retry_attempts)
                .max(1),
            idempotency_ttl: Duration::from_millis(
                env("INFERENCE_IDEMPOTENCY_TTL_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.idempotency_ttl.as_millis() as u64)
                    .max(1_000),
            ),
            idempotency_max_response_bytes: env("INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.idempotency_max_response_bytes)
                .max(1_024),
            chatgpt_base_url: env("CHATGPT_BASE_URL").unwrap_or(defaults.chatgpt_base_url),
            mistral_base_url: env("MISTRAL_BASE_URL").unwrap_or(defaults.mistral_base_url),
            mistral_upstream_path: env("MISTRAL_UPSTREAM_PATH")
                .unwrap_or(defaults.mistral_upstream_path),
            mistral_compact_upstream_path: env("MISTRAL_COMPACT_UPSTREAM_PATH")
                .unwrap_or(defaults.mistral_compact_upstream_path),
            zai_base_url: env("ZAI_BASE_URL").unwrap_or(defaults.zai_base_url),
            zai_upstream_path: env("ZAI_UPSTREAM_PATH").unwrap_or(defaults.zai_upstream_path),
            zai_compact_upstream_path: env("ZAI_COMPACT_UPSTREAM_PATH")
                .unwrap_or(defaults.zai_compact_upstream_path),
            xai_base_url: env("XAI_BASE_URL").unwrap_or(defaults.xai_base_url),
            xai_responses_path: env("XAI_RESPONSES_PATH").unwrap_or(defaults.xai_responses_path),
            xai_chat_completions_path: env("XAI_CHAT_COMPLETIONS_PATH")
                .unwrap_or(defaults.xai_chat_completions_path),
            realtime_provider: env("REALTIME_PROVIDER").unwrap_or(defaults.realtime_provider),
            realtime_webrtc_call_url: realtime_url,
            proxy_models,
            admin_token: env("ADMIN_TOKEN").unwrap_or_default(),
            configured_api_keys,
            internal_job_token: env("V1_EDGE_INTERNAL_JOB_TOKEN"),
        }
    }
}

pub fn parse_byte_limit(value: &str) -> usize {
    let trimmed = value.trim().to_ascii_lowercase();
    let mut digits = String::new();
    let mut suffix = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            if suffix.is_empty() {
                digits.push(ch);
            }
        } else if !ch.is_ascii_whitespace() {
            suffix.push(ch);
        }
    }
    let amount = digits.parse::<f64>().unwrap_or(100.0);
    let multiplier = match suffix.as_str() {
        "kb" | "kib" => 1024.0,
        "mb" | "mib" => 1024.0 * 1024.0,
        "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (amount * multiplier).floor().max(1.0) as usize
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: Option<f64>,
    pub reset_at: Option<u64>,
    pub window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub monthly: Option<UsageWindow>,
    pub fetched_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelBlock {
    pub until: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    #[serde(default)]
    pub model_blocks: HashMap<String, ModelBlock>,
    pub auth_blocked_until: Option<u64>,
    pub last_selected_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapacityProfile {
    pub max_concurrent: Option<u32>,
    pub prefill_tokens_per_second: Option<f64>,
    pub decode_tokens_per_second: Option<f64>,
    pub context_window: Option<u64>,
    pub health_url: Option<String>,
    pub metrics_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntime {
    pub source: Option<String>,
    pub adapter: Option<String>,
    pub endpoint: Option<String>,
    #[serde(default)]
    pub confirmed_model_ids: Vec<String>,
    pub authentication: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Option<String>,
    pub upstream_mode: Option<String>,
    pub compatibility_mode: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub access_token: String,
    pub chatgpt_account_id: Option<String>,
    pub opencode_api_key: Option<String>,
    #[serde(default)]
    pub opencode_headers: HashMap<String, String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    pub priority: Option<i64>,
    pub location: Option<String>,
    pub capacity_profile: Option<CapacityProfile>,
    pub usage: Option<UsageSnapshot>,
    pub state: Option<AccountState>,
    pub local_runtime: Option<LocalRuntime>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingCandidate {
    pub model: String,
    pub provider: Option<String>,
    #[serde(default)]
    pub account_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    pub id: String,
    #[serde(default)]
    pub candidates: Vec<RoutingCandidate>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelAlias {
    pub id: String,
    #[serde(default)]
    pub rules: Vec<RoutingRule>,
    #[serde(default)]
    pub enabled: bool,
    pub defaults: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredProxyApiKey {
    pub id: String,
    pub application: String,
    pub key: String,
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationWebhook {
    pub id: String,
    pub url: String,
    pub secret: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationPolicy {
    pub application: String,
    pub fairness_weight: Option<f64>,
    #[serde(default)]
    pub webhooks: Vec<ApplicationWebhook>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreSettings {
    pub image_request_model_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreFile {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub model_aliases: Vec<ModelAlias>,
    #[serde(default)]
    pub proxy_api_keys: Vec<StoredProxyApiKey>,
    #[serde(default)]
    pub application_policies: Vec<ApplicationPolicy>,
    #[serde(default)]
    pub settings: StoreSettings,
}

#[derive(Clone)]
pub struct AccountStore {
    path: Arc<PathBuf>,
    cache: Arc<RwLock<Option<CachedStore>>>,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct CachedStore {
    modified: Option<SystemTime>,
    data: StoreFile,
}

impl AccountStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(path.into()),
            cache: Arc::new(RwLock::new(None)),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn snapshot(&self) -> Result<StoreFile, String> {
        let modified = fs::metadata(self.path.as_ref())
            .await
            .ok()
            .and_then(|meta| meta.modified().ok());
        if let Some(cached) = self.cache.read().await.as_ref() {
            if cached.modified == modified {
                return Ok(cached.data.clone());
            }
        }

        let raw = fs::read(self.path.as_ref())
            .await
            .map_err(|error| format!("failed to read account store: {error}"))?;
        let data = serde_json::from_slice::<StoreFile>(&raw)
            .map_err(|error| format!("failed to parse account store: {error}"))?;
        *self.cache.write().await = Some(CachedStore {
            modified,
            data: data.clone(),
        });
        Ok(data)
    }

    pub async fn update_account<F>(&self, account_id: &str, update: F) -> Result<(), String>
    where
        F: FnOnce(&mut Account),
    {
        let _guard = self.write_lock.lock().await;
        let mut data = self.snapshot().await?;
        let account = data
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or_else(|| format!("account {account_id} no longer exists"))?;
        update(account);
        let serialized = serde_json::to_vec_pretty(&data)
            .map_err(|error| format!("failed to serialize account store: {error}"))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create account store directory: {error}"))?;
        }
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
        fs::write(&temporary, serialized)
            .await
            .map_err(|error| format!("failed to write account store: {error}"))?;
        fs::rename(&temporary, self.path.as_ref())
            .await
            .map_err(|error| format!("failed to replace account store: {error}"))?;
        let modified = fs::metadata(self.path.as_ref())
            .await
            .ok()
            .and_then(|meta| meta.modified().ok());
        *self.cache.write().await = Some(CachedStore { modified, data });
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub application: String,
}

pub fn constant_time_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = (left.len() ^ right.len()) as u8;
    let max = left.len().max(right.len());
    for index in 0..max {
        difference |= left.get(index).copied().unwrap_or_default()
            ^ right.get(index).copied().unwrap_or_default();
    }
    difference == 0
}

fn parse_configured_api_keys(
    legacy: &str,
    serialized: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut entries = Vec::new();
    if !legacy.trim().is_empty() {
        entries.push(("default".to_owned(), legacy.trim().to_owned()));
    }
    if serialized.trim().is_empty() {
        return Ok(entries);
    }
    let object = serde_json::from_str::<HashMap<String, String>>(serialized)
        .map_err(|_| "PROXY_API_KEYS must be a JSON object".to_owned())?;
    for (application, key) in object {
        let application = application.trim().to_owned();
        let key = key.trim().to_owned();
        if application.is_empty() || key.is_empty() {
            return Err(
                "PROXY_API_KEYS application names and keys must be non-empty strings".to_owned(),
            );
        }
        if entries.iter().any(|(name, _)| name == &application) {
            return Err(format!(
                "Duplicate proxy API key application: {application}"
            ));
        }
        if entries
            .iter()
            .any(|(_, value)| constant_time_equal(value, &key))
        {
            return Err(format!(
                "Proxy API keys must be unique (duplicate for {application})"
            ));
        }
        entries.push((application, key));
    }
    Ok(entries)
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn bearer_or_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = header_value(headers, "x-api-key") {
        return Some(value);
    }
    let value = header_value(headers, "authorization")?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(ToOwned::to_owned)
}

fn admin_session_value(token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"multivibe-admin-session-v1");
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie = header_value(headers, "cookie")?;
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

pub fn authorize(
    headers: &HeaderMap,
    path: &str,
    store: &StoreFile,
    config: &EdgeConfig,
) -> Result<AuthContext, Response> {
    let mut keys = config.configured_api_keys.clone();
    keys.extend(
        store
            .proxy_api_keys
            .iter()
            .map(|entry| (entry.application.clone(), entry.key.clone())),
    );
    if let Some(internal) = config.internal_job_token.as_deref() {
        if header_value(headers, "x-multivibe-internal-token")
            .is_some_and(|value| constant_time_equal(&value, internal))
        {
            return Ok(AuthContext {
                application: header_value(headers, "x-multivibe-internal-application")
                    .unwrap_or_else(|| "internal-job".to_owned()),
            });
        }
    }
    if keys.is_empty() {
        return Ok(AuthContext {
            application: "default".to_owned(),
        });
    }
    if !config.admin_token.is_empty()
        && cookie_value(headers, "multivibe_admin_session").is_some_and(|value| {
            constant_time_equal(&value, &admin_session_value(&config.admin_token))
        })
    {
        return Ok(AuthContext {
            application: "admin".to_owned(),
        });
    }
    let token = bearer_or_api_key(headers);
    if let Some(token) = token {
        if let Some((application, _)) = keys
            .iter()
            .find(|(_, key)| constant_time_equal(&token, key))
        {
            return Ok(AuthContext {
                application: application.clone(),
            });
        }
    }
    if path.ends_with("/messages") {
        Err(anthropic_error_response(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing proxy API key",
        ))
    } else {
        Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing proxy API key",
            "invalid_api_key",
        ))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_id(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("{prefix}_{}", &raw[..24])
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from("{}")))
}

fn error_response(status: StatusCode, message: impl Into<String>, code: &str) -> Response {
    json_response(
        status,
        json!({
            "error": {
                "message": message.into(),
                "type": if status == StatusCode::UNAUTHORIZED { "authentication_error" } else { "invalid_request_error" },
                "code": code,
            }
        }),
    )
}

fn anthropic_error_response(status: StatusCode, message: impl Into<String>) -> Response {
    let kind = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        "authentication_error"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limit_error"
    } else if status == StatusCode::SERVICE_UNAVAILABLE || status.as_u16() == 529 {
        "overloaded_error"
    } else if status.is_client_error() {
        "invalid_request_error"
    } else {
        "api_error"
    };
    json_response(
        status,
        json!({"type": "error", "error": {"type": kind, "message": message.into()}}),
    )
}

async fn read_json_body(
    req: Request<Body>,
    limit: usize,
    anthropic: bool,
) -> Result<(HeaderMap, Value, Bytes), Response> {
    let headers = req.headers().clone();
    let compressed = to_bytes(req.into_body(), limit).await.map_err(|_| {
        if anthropic {
            anthropic_error_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large")
        } else {
            error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body is too large",
                "payload_too_large",
            )
        }
    })?;
    let encoding = header_value(&headers, "content-encoding").unwrap_or_default();
    let body = if encoding
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| value == "zstd")
    {
        decompress_zstd(&compressed, limit).map_err(|message| {
            error_response(StatusCode::BAD_REQUEST, message, "invalid_request_error")
        })?
    } else if encoding
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| !value.is_empty() && value != "identity")
    {
        return Err(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported content encoding",
            "unsupported_content_encoding",
        ));
    } else {
        compressed
    };
    let parsed = serde_json::from_slice::<Value>(&body).map_err(|_| {
        if anthropic {
            anthropic_error_response(StatusCode::BAD_REQUEST, "Invalid JSON")
        } else {
            error_response(
                StatusCode::BAD_REQUEST,
                "Invalid JSON",
                "invalid_request_error",
            )
        }
    })?;
    if !parsed.is_object() {
        return Err(if anthropic {
            anthropic_error_response(
                StatusCode::BAD_REQUEST,
                "Request body must be a JSON object",
            )
        } else {
            error_response(
                StatusCode::BAD_REQUEST,
                "Request body must be a JSON object",
                "invalid_request_error",
            )
        });
    }
    Ok((headers, parsed, body))
}

fn decompress_zstd(input: &[u8], limit: usize) -> Result<Bytes, String> {
    let mut decoder = zstd::stream::read::Decoder::new(Cursor::new(input))
        .map_err(|_| "Failed to decompress zstd body within the request body limit".to_owned())?;
    let mut output = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = decoder.read(&mut buffer).map_err(|_| {
            "Failed to decompress zstd body within the request body limit".to_owned()
        })?;
        if count == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() > limit {
            return Err("Failed to decompress zstd body within the request body limit".to_owned());
        }
    }
    Ok(Bytes::from(output))
}

fn normalize_provider(account: &Account) -> String {
    match account.provider.as_deref() {
        Some("openai-compatible") => "openai-compatible".to_owned(),
        Some("opencode") => "opencode".to_owned(),
        Some("mistral") => "mistral".to_owned(),
        Some("zai") => "zai".to_owned(),
        Some("xai") => "xai".to_owned(),
        _ => "openai".to_owned(),
    }
}

fn normalize_model_key(model: &str) -> String {
    let value = model.trim().to_ascii_lowercase();
    value.rsplit('/').next().unwrap_or(&value).to_owned()
}

fn infer_provider(model: &str) -> String {
    let key = normalize_model_key(model);
    if key.starts_with("mistral")
        || key.starts_with("codestral")
        || key.starts_with("ministral")
        || key.starts_with("pixtral")
        || key.starts_with("open-mistral")
        || key.starts_with("open-mixtral")
    {
        return "mistral".to_owned();
    }
    if key.starts_with("glm-") || key.starts_with("chatglm") || key.starts_with("codegeex") {
        return "zai".to_owned();
    }
    if key.starts_with("grok-") || key == "grok" {
        return "xai".to_owned();
    }
    "openai".to_owned()
}

fn is_local_runtime(account: &Account) -> bool {
    let runtime = account.local_runtime.as_ref();
    account.provider.as_deref() == Some("openai-compatible")
        && account.location.as_deref() == Some("local")
        && account.access_token.is_empty()
        && runtime.and_then(|value| value.source.as_deref()) == Some("multivibe-local-discovery")
        && runtime.and_then(|value| value.authentication.as_deref()) == Some("none")
        && !runtime
            .map(|value| value.confirmed_model_ids.is_empty())
            .unwrap_or(true)
        && account.base_url.is_some()
}

fn account_usable(account: &Account, model: &str, blocked: &HashMap<String, u64>) -> bool {
    if !account.enabled {
        return false;
    }
    if account.access_token.is_empty() && !is_local_runtime(account) {
        return false;
    }
    let now = now_ms();
    if account
        .state
        .as_ref()
        .and_then(|state| state.auth_blocked_until)
        .is_some_and(|until| until > now)
    {
        return false;
    }
    let model_key = normalize_model_key(model);
    if account
        .state
        .as_ref()
        .and_then(|state| state.model_blocks.get(&model_key))
        .is_some_and(|block| block.until > now)
    {
        return false;
    }
    blocked
        .get(&format!("{}:{model_key}", account.id))
        .is_none_or(|until| *until <= now)
}

fn usage_percent(window: Option<&UsageWindow>) -> Option<f64> {
    window
        .and_then(|value| value.used_percent)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

fn select_accounts(
    accounts: &[Account],
    route: &RouteCandidate,
    blocked: &HashMap<String, u64>,
    selected: &HashMap<String, String>,
) -> Vec<Account> {
    let mut candidates = accounts
        .iter()
        .filter(|account| {
            normalize_provider(account) == route.provider.as_deref().unwrap_or("")
                && (route.account_ids.is_empty() || route.account_ids.contains(&account.id))
                && account_usable(account, &route.model, blocked)
        })
        .cloned()
        .collect::<Vec<_>>();
    let provider = route.provider.clone().unwrap_or_default();
    candidates.sort_by(|left, right| {
        let left_usage = usage_percent(
            left.usage
                .as_ref()
                .and_then(|usage| usage.secondary.as_ref()),
        );
        let right_usage = usage_percent(
            right
                .usage
                .as_ref()
                .and_then(|usage| usage.secondary.as_ref()),
        );
        match (left_usage, right_usage) {
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) if left != right => {
                left.partial_cmp(&right).unwrap_or(Ordering::Equal)
            }
            _ => {
                let priority = left
                    .priority
                    .unwrap_or(i64::MAX)
                    .cmp(&right.priority.unwrap_or(i64::MAX));
                if priority == Ordering::Equal {
                    left.id.cmp(&right.id)
                } else {
                    priority
                }
            }
        }
    });
    if let Some(previous) = selected.get(&provider) {
        if let Some(index) = candidates
            .iter()
            .position(|account| &account.id == previous)
        {
            candidates.rotate_left((index + 1) % candidates.len());
        }
    }
    candidates
}

#[derive(Clone, Debug)]
struct RouteCandidate {
    requested_model: String,
    model: String,
    provider: Option<String>,
}

fn routes_for_model(store: &StoreFile, model: &str, default_model: &str) -> Vec<RouteCandidate> {
    let requested = if model.trim().is_empty() {
        default_model
    } else {
        model
    };
    if let Some(alias) = store
        .model_aliases
        .iter()
        .find(|alias| alias.enabled && alias.id.eq_ignore_ascii_case(requested))
    {
        let mut routes = alias
            .rules
            .iter()
            .flat_map(|rule| rule.candidates.iter())
            .map(|candidate| RouteCandidate {
                requested_model: requested.to_owned(),
                model: candidate.model.clone(),
                provider: candidate
                    .provider
                    .clone()
                    .or_else(|| Some(infer_provider(&candidate.model))),
            })
            .collect::<Vec<_>>();
        if !routes.is_empty() {
            return routes;
        }
    }
    vec![RouteCandidate {
        requested_model: requested.to_owned(),
        model: requested.to_owned(),
        provider: Some(infer_provider(requested)),
    }]
}

fn trim_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_owned()
}

fn account_base_url(account: &Account, config: &EdgeConfig) -> String {
    match normalize_provider(account).as_str() {
        "openai-compatible" => account.base_url.clone().unwrap_or_default(),
        "opencode" => account
            .base_url
            .clone()
            .unwrap_or_else(|| "https://opencode.ai/zen".to_owned()),
        "mistral" => config.mistral_base_url.clone(),
        "zai" => config.zai_base_url.clone(),
        "xai" => account
            .base_url
            .clone()
            .unwrap_or_else(|| config.xai_base_url.clone()),
        _ => config.chatgpt_base_url.clone(),
    }
}

fn resolve_upstream_mode(account: &Account, chat_route: bool, compact: bool) -> bool {
    if let Some(mode) = account.upstream_mode.as_deref() {
        return mode == "chat/completions";
    }
    match normalize_provider(account).as_str() {
        "zai" => true,
        "openai-compatible" => account.compatibility_mode.as_deref() != Some("responses"),
        _ if compact => false,
        _ if chat_route => false,
        _ => false,
    }
}

fn upstream_path(
    account: &Account,
    config: &EdgeConfig,
    sends_chat: bool,
    compact: bool,
) -> String {
    match normalize_provider(account).as_str() {
        "mistral" => {
            if compact {
                config.mistral_compact_upstream_path.clone()
            } else {
                config.mistral_upstream_path.clone()
            }
        }
        "zai" => {
            if compact {
                config.zai_compact_upstream_path.clone()
            } else {
                config.zai_upstream_path.clone()
            }
        }
        "openai-compatible" | "opencode" => {
            if sends_chat {
                "/v1/chat/completions".to_owned()
            } else {
                "/v1/responses".to_owned()
            }
        }
        "xai" => {
            if sends_chat {
                config.xai_chat_completions_path.clone()
            } else {
                config.xai_responses_path.clone()
            }
        }
        _ => {
            if compact {
                std::env::var("UPSTREAM_COMPACT_PATH")
                    .unwrap_or_else(|_| "/backend-api/codex/responses/compact".to_owned())
            } else {
                std::env::var("UPSTREAM_PATH")
                    .unwrap_or_else(|_| "/backend-api/codex/responses".to_owned())
            }
        }
    }
}

fn upstream_url(account: &Account, config: &EdgeConfig, sends_chat: bool, compact: bool) -> String {
    format!(
        "{}{}",
        trim_slashes(&account_base_url(account, config)),
        upstream_path(account, config, sends_chat, compact)
    )
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn object_value(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn json_string(value: &Value) -> String {
    value.to_string()
}

fn tool_content_to_output(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(parts)) => {
            let texts = parts
                .iter()
                .filter_map(|part| {
                    if let Some(text) = part.as_str() {
                        return Some(text.to_owned());
                    }
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>();
            if texts.is_empty() {
                Value::String(json_string(value.unwrap_or(&Value::Null)))
            } else {
                Value::String(texts.join("\n"))
            }
        }
        Some(value) => Value::String(json_string(value)),
        None => Value::String(String::new()),
    }
}

fn response_image_to_chat(value: &Value) -> Option<Value> {
    if value.get("type").and_then(Value::as_str) != Some("input_image") {
        return None;
    }
    let url = value_string(value.get("image_url"))
        .or_else(|| {
            value
                .get("image_url")
                .and_then(|image| value_string(image.get("url")))
        })
        .or_else(|| {
            value_string(value.get("data")).map(|data| {
                let mime =
                    value_string(value.get("mime_type")).unwrap_or_else(|| "image/png".to_owned());
                format!("data:{mime};base64,{data}")
            })
        })?;
    let mut image_url = Map::new();
    image_url.insert("url".to_owned(), Value::String(url));
    if let Some(detail) = value_string(value.get("detail")).or_else(|| {
        value
            .get("image_url")
            .and_then(|image| value_string(image.get("detail")))
    }) {
        image_url.insert("detail".to_owned(), Value::String(detail));
    }
    Some(json!({"type": "image_url", "image_url": Value::Object(image_url)}))
}

fn input_content(value: Option<&Value>, role: &str) -> Vec<Value> {
    let text_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    match value {
        Some(Value::String(text)) => vec![json!({"type": text_type, "text": text})],
        Some(Value::Array(parts)) => {
            let mut output = Vec::new();
            for part in parts {
                if let Some(text) = part.as_str() {
                    output.push(json!({"type": text_type, "text": text}));
                } else if matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("text" | "input_text" | "output_text")
                ) {
                    if let Some(text) = value_string(part.get("text")) {
                        output.push(json!({"type": text_type, "text": text}));
                    }
                } else if role != "assistant"
                    && part.get("type").and_then(Value::as_str) == Some("image_url")
                {
                    let image_url = part.get("image_url").and_then(|image| {
                        value_string(Some(image)).or_else(|| value_string(image.get("url")))
                    });
                    if let Some(image_url) = image_url {
                        let mut item = json!({"type": "input_image", "image_url": image_url});
                        if let Some(detail) = value_string(part.get("detail")).or_else(|| {
                            part.get("image_url")
                                .and_then(|image| value_string(image.get("detail")))
                        }) {
                            item["detail"] = Value::String(detail);
                        }
                        output.push(item);
                    }
                }
            }
            if output.is_empty() {
                vec![json!({"type": text_type, "text": json_string(value.unwrap_or(&Value::Null))})]
            } else {
                output
            }
        }
        Some(value) => vec![json!({"type": text_type, "text": json_string(value)})],
        None => vec![json!({"type": text_type, "text": ""})],
    }
}

fn apply_codex_parity_defaults(mut payload: Map<String, Value>, session_id: Option<&str>) -> Value {
    payload.insert("store".to_owned(), Value::Bool(false));
    payload.insert("stream".to_owned(), Value::Bool(true));
    let has_tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if !payload.contains_key("tool_choice") && has_tools {
        payload.insert("tool_choice".to_owned(), Value::String("auto".to_owned()));
    }
    if !has_tools && payload.get("tool_choice").and_then(Value::as_str) == Some("auto") {
        payload.remove("tool_choice");
    }
    payload
        .entry("parallel_tool_calls".to_owned())
        .or_insert(Value::Bool(true));
    let mut text = payload
        .remove("text")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    text.entry("verbosity".to_owned())
        .or_insert(Value::String("medium".to_owned()));
    payload.insert("text".to_owned(), Value::Object(text));
    match payload.get_mut("include") {
        Some(Value::Array(include)) => {
            if !include
                .iter()
                .any(|value| value.as_str() == Some("reasoning.encrypted_content"))
            {
                include.push(Value::String("reasoning.encrypted_content".to_owned()));
            }
        }
        _ => {
            payload.insert("include".to_owned(), json!(["reasoning.encrypted_content"]));
        }
    }
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        payload
            .entry("prompt_cache_key".to_owned())
            .or_insert_with(|| Value::String(session_id.to_owned()));
    }
    let instructions = value_string(payload.get("instructions"));
    payload.insert(
        "instructions".to_owned(),
        Value::String(instructions.unwrap_or_else(|| "You are a helpful assistant.".to_owned())),
    );
    if let Some(effort) = payload.remove("reasoning_effort") {
        let mut reasoning = payload
            .remove("reasoning")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        reasoning.insert("effort".to_owned(), effort);
        payload.insert("reasoning".to_owned(), Value::Object(reasoning));
    }
    if let Some(reasoning) = payload.get_mut("reasoning").and_then(Value::as_object_mut) {
        if reasoning.contains_key("effort") {
            reasoning
                .entry("summary".to_owned())
                .or_insert(Value::String("auto".to_owned()));
        }
    }
    Value::Object(payload)
}

fn normalize_responses_payload(body: &Value, session_id: Option<&str>) -> Value {
    let mut payload = object_value(body);
    if !payload.get("input").is_some_and(Value::is_array) {
        let text = value_string(payload.get("input"))
            .or_else(|| value_string(payload.get("prompt")))
            .unwrap_or_default();
        payload.insert(
            "input".to_owned(),
            json!([{"role": "user", "content": [{"type": "input_text", "text": text}]}]),
        );
    }
    if payload
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.starts_with("gpt-5"))
    {
        payload.remove("max_output_tokens");
    }
    apply_codex_parity_defaults(payload, session_id)
}

fn chat_completions_to_responses(body: &Value, session_id: Option<&str>) -> Value {
    let object = object_value(body);
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let system = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| value_string(message.get("content")))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut input = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if role == "system" {
            continue;
        }
        if role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": value_string(message.get("tool_call_id")).unwrap_or_else(|| new_id("call")),
                "output": tool_content_to_output(message.get("content")),
            }));
            continue;
        }
        if role == "assistant" {
            let content = input_content(message.get("content"), "assistant");
            if !content.is_empty() {
                input.push(json!({"role": "assistant", "content": content}));
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
                    input.push(json!({
                        "type": "function_call",
                        "call_id": value_string(call.get("id")).unwrap_or_else(|| new_id("call")),
                        "name": value_string(function.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                        "arguments": function.get("arguments").map(json_string).unwrap_or_else(|| "{}".to_owned()),
                    }));
                }
            }
            continue;
        }
        input.push(
            json!({"role": "user", "content": input_content(message.get("content"), "user")}),
        );
    }
    if input
        .first()
        .and_then(|value| value.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        input.insert(
            0,
            json!({"role": "user", "content": [{"type": "input_text", "text": " "}]}),
        );
    }
    let mut payload = Map::new();
    payload.insert(
        "model".to_owned(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    if let Some(instructions) =
        value_string(object.get("instructions")).or_else(|| (!system.is_empty()).then_some(system))
    {
        payload.insert("instructions".to_owned(), Value::String(instructions));
    }
    payload.insert("input".to_owned(), Value::Array(input));
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        payload.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .map(|tool| {
                        if tool.get("type").and_then(Value::as_str) == Some("function") {
                            let function = tool.get("function").cloned().unwrap_or_else(|| json!({}));
                            json!({
                                "type": "function",
                                "name": function.get("name"),
                                "description": function.get("description"),
                                "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                                "strict": function.get("strict").cloned().unwrap_or(Value::Null),
                            })
                        } else {
                            tool.clone()
                        }
                    })
                    .collect(),
            ),
        );
    }
    for key in [
        "tool_choice",
        "reasoning_effort",
        "reasoning",
        "temperature",
    ] {
        if let Some(value) = object.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    apply_codex_parity_defaults(payload, session_id)
}

fn responses_to_chat_completions(body: &Value, client_stream: bool) -> Value {
    let object = object_value(body);
    let mut messages = Vec::new();
    if let Some(instructions) = value_string(object.get("instructions")) {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    if let Some(input) = object.get("input") {
        if let Some(text) = input.as_str() {
            messages.push(json!({"role": "user", "content": text}));
        } else if let Some(items) = input.as_array() {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("input_image") => {
                        if let Some(part) = response_image_to_chat(item) {
                            messages.push(json!({"role": "user", "content": [part]}));
                        }
                    }
                    Some("function_call") => {
                        let id = value_string(item.get("call_id"))
                            .or_else(|| value_string(item.get("id")))
                            .unwrap_or_else(|| new_id("call"));
                        messages.push(json!({
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                                    "arguments": item.get("arguments").map(json_string).unwrap_or_else(|| "{}".to_owned()),
                                }
                            }]
                        }));
                    }
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": value_string(item.get("call_id")).or_else(|| value_string(item.get("id"))).unwrap_or_else(|| new_id("call")),
                            "content": item.get("output").map(|value| if let Some(text) = value.as_str() { text.to_owned() } else { json_string(value) }).unwrap_or_default(),
                        }));
                    }
                    _ => {
                        let role = if item.get("role").and_then(Value::as_str) == Some("assistant")
                        {
                            "assistant"
                        } else {
                            "user"
                        };
                        let content = item
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                Value::Array(
                                    parts
                                        .iter()
                                        .filter_map(|part| {
                                            if let Some(text) = part.as_str() {
                                                Some(json!({"type": "text", "text": text}))
                                            } else if let Some(text) =
                                                value_string(part.get("text"))
                                            {
                                                Some(json!({"type": "text", "text": text}))
                                            } else {
                                                response_image_to_chat(part)
                                            }
                                        })
                                        .collect(),
                                )
                            })
                            .or_else(|| value_string(item.get("content")).map(Value::String))
                            .unwrap_or_else(|| Value::String(String::new()));
                        messages.push(json!({"role": role, "content": content}));
                    }
                }
            }
        }
    }
    let mut output = Map::new();
    output.insert(
        "model".to_owned(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    output.insert("messages".to_owned(), Value::Array(messages));
    output.insert("stream".to_owned(), Value::Bool(client_stream));
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        output.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .map(|tool| {
                        if tool.get("type").and_then(Value::as_str) == Some("function") {
                            json!({"type": "function", "function": {
                                "name": tool.get("name"),
                                "description": tool.get("description"),
                                "parameters": tool.get("parameters"),
                                "strict": tool.get("strict"),
                            }})
                        } else {
                            tool.clone()
                        }
                    })
                    .collect(),
            ),
        );
    }
    for key in ["tool_choice", "temperature"] {
        if let Some(value) = object.get(key) {
            output.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(value) = object
        .get("max_tokens")
        .or_else(|| object.get("max_completion_tokens"))
        .or_else(|| object.get("max_output_tokens"))
    {
        output.insert("max_tokens".to_owned(), value.clone());
    }
    Value::Object(output)
}

fn sanitize_generic_chat_payload(body: &Value) -> Value {
    let mut payload = object_value(body);
    for key in [
        "reasoning",
        "reasoning_effort",
        "include",
        "text",
        "store",
        "parallel_tool_calls",
    ] {
        payload.remove(key);
    }
    if let Some(value) = payload.remove("max_output_tokens") {
        payload.entry("max_tokens".to_owned()).or_insert(value);
    }
    if let Some(value) = payload.remove("max_completion_tokens") {
        payload.entry("max_tokens".to_owned()).or_insert(value);
    }
    Value::Object(payload)
}

fn is_claude_code_request(headers: &HeaderMap) -> bool {
    header_value(headers, "user-agent").is_some_and(|value| value.starts_with("claude-cli/"))
        && header_value(headers, "x-app").is_some_and(|value| value.eq_ignore_ascii_case("cli"))
}

fn anthropic_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    (part.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| value_string(part.get("text")))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn anthropic_image_to_responses(part: &Value) -> Option<Value> {
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let source = part.get("source")?;
    match source.get("type").and_then(Value::as_str) {
        Some("base64") => {
            let mime =
                value_string(source.get("media_type")).unwrap_or_else(|| "image/png".to_owned());
            let data = value_string(source.get("data"))?;
            Some(json!({"type": "input_image", "image_url": format!("data:{mime};base64,{data}")}))
        }
        Some("url") => {
            Some(json!({"type": "input_image", "image_url": value_string(source.get("url"))?}))
        }
        _ => None,
    }
}

fn anthropic_to_responses(body: &Value, claude_code: bool, config: &EdgeConfig) -> Value {
    let object = object_value(body);
    let mut input = Vec::new();
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = if message.get("role").and_then(Value::as_str) == Some("assistant") {
                "assistant"
            } else {
                "user"
            };
            let raw_content = message
                .get("content")
                .cloned()
                .unwrap_or_else(|| json!([{"type": "text", "text": ""}]));
            let parts = raw_content.as_array().cloned().unwrap_or_else(|| {
                vec![json!({"type": "text", "text": raw_content.as_str().unwrap_or("")})]
            });
            let mut message_content = Vec::new();
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = value_string(part.get("text")) {
                        message_content.push(json!({"type": if role == "assistant" { "output_text" } else { "input_text" }, "text": text}));
                    }
                } else if role == "user" {
                    if let Some(image) = anthropic_image_to_responses(&part) {
                        message_content.push(image);
                    }
                } else if part.get("type").and_then(Value::as_str) == Some("tool_use") {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": value_string(part.get("id")).unwrap_or_else(|| new_id("toolu")),
                        "name": value_string(part.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                        "arguments": part.get("input").map(json_string).unwrap_or_else(|| "{}".to_owned()),
                    }));
                } else if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": value_string(part.get("tool_use_id")).unwrap_or_default(),
                        "output": tool_content_to_output(part.get("content")),
                    }));
                }
            }
            if !message_content.is_empty() {
                input.push(json!({"role": role, "content": message_content}));
            }
        }
    }
    let requested_model = value_string(object.get("model")).unwrap_or_default();
    let mapped_model = if claude_code && requested_model.to_ascii_lowercase().contains("claude") {
        if requested_model.to_ascii_lowercase().contains("haiku")
            || requested_model.to_ascii_lowercase().contains("fast")
        {
            std::env::var("CLAUDE_CODE_FAST_MODEL").unwrap_or_else(|_| "gpt-5.4-mini".to_owned())
        } else {
            std::env::var("CLAUDE_CODE_MODEL").unwrap_or_else(|_| "gpt-5.6-luna".to_owned())
        }
    } else {
        requested_model
    };
    let mut payload = Map::new();
    payload.insert("model".to_owned(), Value::String(mapped_model));
    payload.insert("input".to_owned(), Value::Array(input));
    payload.insert(
        "stream".to_owned(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    if let Some(system) = anthropic_text(object.get("system")) {
        payload.insert("instructions".to_owned(), Value::String(system));
    }
    if let Some(max_tokens) = object.get("max_tokens") {
        payload.insert("max_output_tokens".to_owned(), max_tokens.clone());
    }
    if let Some(metadata) = object.get("metadata") {
        payload.insert("metadata".to_owned(), metadata.clone());
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        payload.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .map(|tool| json!({
                        "type": "function",
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                    }))
                    .collect(),
            ),
        );
    }
    if let Some(choice) = object.get("tool_choice").and_then(Value::as_object) {
        match choice.get("type").and_then(Value::as_str) {
            Some("auto") => {
                payload.insert("tool_choice".to_owned(), Value::String("auto".to_owned()));
            }
            Some("any") => {
                payload.insert(
                    "tool_choice".to_owned(),
                    Value::String("required".to_owned()),
                );
            }
            Some("none") => {
                payload.insert("tool_choice".to_owned(), Value::String("none".to_owned()));
            }
            Some("tool") => {
                payload.insert(
                    "tool_choice".to_owned(),
                    json!({"type": "function", "name": choice.get("name")}),
                );
            }
            _ => {}
        }
    }
    if let Some(thinking) = object.get("thinking").and_then(Value::as_object) {
        if thinking.get("type").and_then(Value::as_str) != Some("disabled") {
            let budget = thinking
                .get("budget_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(8_192);
            let effort = if budget <= 1_024 {
                "low"
            } else if budget <= 8_192 {
                "medium"
            } else {
                "high"
            };
            payload.insert("reasoning".to_owned(), json!({"effort": effort}));
        }
    }
    // `config` is intentionally used only for defaults in future-compatible
    // deployments; keeping the argument makes the conversion self-contained.
    let _ = config;
    Value::Object(payload)
}

fn safe_json(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| Value::Object(Map::new()))
        }
        Some(value) => value.clone(),
        None => Value::Object(Map::new()),
    }
}

fn response_usage(response: &Value) -> Value {
    let usage = response.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "input_tokens": usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "output_tokens": usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "cache_creation_input_tokens": usage.get("input_tokens_details").and_then(|value| value.get("cache_creation_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "cache_read_input_tokens": usage.get("input_tokens_details").and_then(|value| value.get("cached_tokens")).and_then(Value::as_u64).unwrap_or(0),
    })
}

fn responses_to_anthropic(response: &Value, requested_model: &str) -> Value {
    let mut content = Vec::new();
    let mut has_tool = false;
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if matches!(
                            part.get("type").and_then(Value::as_str),
                            Some("output_text" | "text")
                        ) {
                            if let Some(text) = value_string(part.get("text")) {
                                content.push(json!({"type": "text", "text": text}));
                            }
                        }
                    }
                }
            } else if item.get("type").and_then(Value::as_str) == Some("function_call") {
                has_tool = true;
                content.push(json!({
                    "type": "tool_use",
                    "id": value_string(item.get("call_id")).or_else(|| value_string(item.get("id"))).unwrap_or_default(),
                    "name": value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                    "input": safe_json(item.get("arguments")),
                }));
            }
        }
    }
    let stop_reason = if has_tool {
        "tool_use"
    } else if response.get("status").and_then(Value::as_str) == Some("incomplete")
        && response
            .get("incomplete_details")
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str)
            == Some("max_output_tokens")
    {
        "max_tokens"
    } else {
        "end_turn"
    };
    json!({
        "id": format!("msg_{}", value_string(response.get("id")).unwrap_or_else(|| new_id("response"))),
        "type": "message",
        "role": "assistant",
        "model": requested_model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": response_usage(response),
    })
}

fn is_assistant_output(value: &Value) -> bool {
    if value.get("object").and_then(Value::as_str) == Some("chat.completion") {
        let choice = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        let message = choice.and_then(|choice| choice.get("message"));
        let text = message
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return !text.trim().is_empty()
            || message
                .and_then(|message| message.get("tool_calls"))
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty());
    }
    if value.get("object").and_then(Value::as_str) == Some("response") {
        return value
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call")
                        || (item.get("type").and_then(Value::as_str) == Some("message")
                            && item
                                .get("content")
                                .and_then(Value::as_array)
                                .is_some_and(|parts| {
                                    parts.iter().any(|part| {
                                        value_string(part.get("text"))
                                            .is_some_and(|text| !text.trim().is_empty())
                                    })
                                }))
                })
            });
    }
    false
}

fn sanitize_response(value: &Value) -> Value {
    let mut output = object_value(value);
    output.remove("reasoning");
    if let Some(items) = output.get_mut("output").and_then(Value::as_array_mut) {
        items.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("function_call")
                && item
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_ascii_lowercase().starts_with("functions."))
            {
                *item = json!({"type": "message", "role": "assistant", "content": []});
            }
        }
    }
    Value::Object(output)
}

fn sanitize_chat(value: &Value) -> Value {
    let mut output = object_value(value);
    output.remove("reasoning");
    if let Some(choices) = output.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) {
                if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                    calls.retain(|call| {
                        !call
                            .get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .is_some_and(|name| name.to_ascii_lowercase().starts_with("functions."))
                    });
                }
            }
        }
    }
    Value::Object(output)
}

fn chat_to_response(value: &Value, fallback_model: &str) -> Value {
    let value = sanitize_chat(value);
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message = choice.get("message").cloned().unwrap_or_else(|| json!({}));
    let mut output = Vec::new();
    let text = message
        .get("content")
        .map(|content| {
            if let Some(text) = content.as_str() {
                text.to_owned()
            } else if let Some(parts) = content.as_array() {
                parts
                    .iter()
                    .filter_map(|part| value_string(part.get("text")))
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                String::new()
            }
        })
        .unwrap_or_default()
        .replace("<think>", "")
        .replace("</think>", "");
    if !text.trim().is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text.trim_start()}]}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
            output.push(json!({
                "type": "function_call",
                "id": call.get("id"),
                "call_id": call.get("id"),
                "name": function.get("name").cloned().unwrap_or_else(|| Value::String("unknown".to_owned())),
                "arguments": function.get("arguments").map(json_string).unwrap_or_else(|| "{}".to_owned()),
            }));
        }
    }
    if output.is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ""}]}));
    }
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "id": new_id("resp"),
        "object": "response",
        "created_at": value.get("created").and_then(Value::as_i64).unwrap_or((now_ms() / 1000) as i64),
        "model": value.get("model").cloned().unwrap_or_else(|| Value::String(fallback_model.to_owned())),
        "status": "completed",
        "output": output,
        "usage": {
            "input_tokens": usage.get("prompt_tokens").or_else(|| usage.get("input_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "output_tokens": usage.get("completion_tokens").or_else(|| usage.get("output_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        }
    })
}

fn response_to_chat(value: &Value, model: &str) -> Value {
    let value = sanitize_response(value);
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    if let Some(items) = value.get("output").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if matches!(
                                part.get("type").and_then(Value::as_str),
                                Some("output_text" | "refusal")
                            ) {
                                content.push_str(
                                    value_string(part.get("text"))
                                        .or_else(|| value_string(part.get("refusal")))
                                        .as_deref()
                                        .unwrap_or_default(),
                                );
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let name =
                        value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned());
                    if !name.to_ascii_lowercase().starts_with("functions.") {
                        let id = value_string(item.get("call_id"))
                            .or_else(|| value_string(item.get("id")))
                            .unwrap_or_else(|| new_id("call"));
                        tool_calls.push(json!({"id": id, "type": "function", "function": {"name": name, "arguments": item.get("arguments").map(json_string).unwrap_or_else(|| "{}".to_owned())}}));
                    }
                }
                _ => {}
            }
        }
    }
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    let mut message = json!({"role": "assistant", "content": content});
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    json!({
        "id": new_id("chatcmpl"),
        "object": "chat.completion",
        "created": now_ms() / 1000,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": if message.get("tool_calls").is_some() { "tool_calls" } else { "stop" }}],
        "usage": {
            "prompt_tokens": usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "completion_tokens": usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        }
    })
}

fn sse_frame(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {}\n\n", data)
}

fn response_completed_sse(value: &Value) -> String {
    sse_frame(
        "response.completed",
        &json!({"type": "response.completed", "response": sanitize_response(value)}),
    )
}

fn chat_completion_sse(value: &Value) -> String {
    format!("data: {}\n\ndata: [DONE]\n\n", value)
}

fn parse_sse_events(text: &str) -> Vec<(String, Value)> {
    text.replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|frame| {
            let mut event = String::new();
            let mut data = Vec::new();
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.trim());
                }
            }
            if data.is_empty() {
                return None;
            }
            let text = data.join("\n");
            if text == "[DONE]" {
                return Some((event, Value::String("[DONE]".to_owned())));
            }
            serde_json::from_str::<Value>(&text)
                .ok()
                .map(|value| (event, value))
        })
        .collect()
}

fn response_from_sse(text: &str, model: &str) -> Value {
    let mut completed = None;
    let mut output_text = String::new();
    let mut function_calls: HashMap<String, Value> = HashMap::new();
    for (_, event) in parse_sse_events(text) {
        if event.as_str() == Some("[DONE]") {
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            completed = event.get("response").cloned();
        } else if event.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
            output_text.push_str(
                value_string(event.get("delta"))
                    .as_deref()
                    .unwrap_or_default(),
            );
        } else if event.get("type").and_then(Value::as_str)
            == Some("response.function_call_arguments.delta")
        {
            let id = value_string(event.get("item_id")).unwrap_or_else(|| "call_0".to_owned());
            let call = function_calls.entry(id.clone()).or_insert_with(|| json!({"type": "function_call", "id": id, "call_id": id, "name": "unknown", "arguments": ""}));
            let delta = value_string(event.get("delta")).unwrap_or_default();
            call["arguments"] = Value::String(format!(
                "{}{}",
                call.get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                delta
            ));
        }
    }
    if let Some(value) = completed {
        return sanitize_response(&value);
    }
    let mut output = Vec::new();
    if !output_text.is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": output_text}]}));
    }
    output.extend(function_calls.into_values());
    json!({"id": new_id("resp"), "object": "response", "created_at": now_ms() / 1000, "model": model, "status": "completed", "output": output, "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}})
}

fn chat_from_sse(text: &str, model: &str) -> Value {
    let mut id = new_id("chatcmpl");
    let mut created = now_ms() / 1000;
    let mut content = String::new();
    let mut usage = json!({});
    let mut finish_reason = "stop";
    let mut tool_calls: Vec<Value> = Vec::new();
    for (_, event) in parse_sse_events(text) {
        if event.as_str() == Some("[DONE]") {
            continue;
        }
        if event.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
            continue;
        }
        if let Some(value) = value_string(event.get("id")) {
            id = value;
        }
        if let Some(value) = event.get("created").and_then(Value::as_u64) {
            created = value;
        }
        if let Some(value) = event.get("usage") {
            usage = value.clone();
        }
        if let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        {
            if let Some(reason) = value_string(choice.get("finish_reason")) {
                finish_reason = Box::leak(reason.into_boxed_str());
            }
            if let Some(delta) = choice.get("delta") {
                if let Some(value) = value_string(delta.get("content")) {
                    content.push_str(&value);
                }
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let index = call
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(tool_calls.len() as u64)
                            as usize;
                        while tool_calls.len() <= index {
                            tool_calls.push(json!({"id": new_id("call"), "type": "function", "function": {"name": "", "arguments": ""}}));
                        }
                        if let Some(id) = value_string(call.get("id")) {
                            tool_calls[index]["id"] = Value::String(id);
                        }
                        if let Some(function) = call.get("function") {
                            if let Some(name) = value_string(function.get("name")) {
                                tool_calls[index]["function"]["name"] = Value::String(name);
                            }
                            if let Some(arguments) = value_string(function.get("arguments")) {
                                tool_calls[index]["function"]["arguments"] =
                                    Value::String(format!(
                                        "{}{}",
                                        tool_calls[index]["function"]
                                            .get("arguments")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default(),
                                        arguments
                                    ));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut message = json!({"role": "assistant", "content": content});
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    json!({"id": id, "object": "chat.completion", "created": created, "model": model, "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}], "usage": usage})
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamTransform {
    None,
    ChatToResponse,
    ResponseToChat,
    ResponseToAnthropic,
}

struct BufferedReply {
    status: StatusCode,
    headers: Vec<(String, String)>,
    body: Bytes,
}

struct StreamingReply {
    status: StatusCode,
    headers: Vec<(String, String)>,
    upstream: reqwest::Response,
    transform: StreamTransform,
    requested_model: String,
}

enum ProxyResult {
    Buffered(BufferedReply),
    Streaming(StreamingReply),
}

#[derive(Clone)]
struct CachedReply {
    expires_at: u64,
    reply: Arc<BufferedReplyData>,
}

#[derive(Clone)]
struct BufferedReplyData {
    status: StatusCode,
    headers: Vec<(String, String)>,
    body: Bytes,
}

struct TraceSink {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl TraceSink {
    async fn record(
        &self,
        route: &str,
        application: &str,
        account: Option<&Account>,
        status: u16,
        stream: bool,
        started_at: u64,
        error: Option<&str>,
    ) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let _guard = self.lock.lock().await;
        let mut entry = json!({
            "at": now_ms(),
            "route": route,
            "application": application,
            "status": status,
            "stream": stream,
            "latencyMs": now_ms().saturating_sub(started_at),
        });
        if let Some(account) = account {
            entry["accountId"] = Value::String(account.id.clone());
            if let Some(email) = account.email.as_deref() {
                entry["accountEmail"] = Value::String(email.to_owned());
            }
            entry["provider"] = Value::String(normalize_provider(account));
        }
        if let Some(error) = error {
            entry["error"] = Value::String(error.chars().take(500).collect());
        }
        if let Ok(line) = serde_json::to_vec(&entry) {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent).await;
            }
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
            {
                use tokio::io::AsyncWriteExt;
                let _ = file.write_all(&line).await;
                let _ = file.write_all(b"\n").await;
            }
        }
    }
}

#[derive(Clone)]
pub struct EdgeState {
    pub config: Arc<EdgeConfig>,
    pub store: AccountStore,
    pub client: reqwest::Client,
    blocked: Arc<Mutex<HashMap<String, u64>>>,
    selected: Arc<Mutex<HashMap<String, String>>>,
    idempotency: Arc<Mutex<HashMap<String, CachedReply>>>,
    pub jobs: Arc<JobManager>,
    trace: Arc<TraceSink>,
    capacity_version: Arc<AtomicU64>,
}

impl EdgeState {
    pub async fn new(config: EdgeConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(Policy::limited(5))
            .build()
            .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
        Ok(Self {
            store: AccountStore::new(config.store_path.clone()),
            jobs: Arc::new(JobManager::new(config.jobs_path.clone()).await?),
            trace: Arc::new(TraceSink {
                path: config.trace_path.clone(),
                lock: Mutex::new(()),
            }),
            config: Arc::new(config),
            client,
            blocked: Arc::new(Mutex::new(HashMap::new())),
            selected: Arc::new(Mutex::new(HashMap::new())),
            idempotency: Arc::new(Mutex::new(HashMap::new())),
            capacity_version: Arc::new(AtomicU64::new(1)),
        })
    }

    async fn mark_blocked(&self, account: &Account, model: &str, duration: Duration) {
        self.blocked.lock().await.insert(
            format!("{}:{}", account.id, normalize_model_key(model)),
            now_ms() + duration.as_millis() as u64,
        );
    }

    async fn cached_idempotency(&self, key: &str) -> Option<BufferedReply> {
        let mut cache = self.idempotency.lock().await;
        let now = now_ms();
        cache.retain(|_, value| value.expires_at > now);
        cache.get(key).map(|value| BufferedReply {
            status: value.reply.status,
            headers: value.reply.headers.clone(),
            body: value.reply.body.clone(),
        })
    }

    async fn store_idempotency(&self, key: String, reply: &BufferedReply) {
        if reply.body.len() > self.config.idempotency_max_response_bytes {
            return;
        }
        let mut cache = self.idempotency.lock().await;
        cache.insert(
            key,
            CachedReply {
                expires_at: now_ms() + self.config.idempotency_ttl.as_millis() as u64,
                reply: Arc::new(BufferedReplyData {
                    status: reply.status,
                    headers: reply.headers.clone(),
                    body: reply.body.clone(),
                }),
            },
        );
    }
}

fn set_header(headers: &mut HeaderMap, name: &str, value: impl AsRef<str>) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::try_from(name),
        HeaderValue::from_str(value.as_ref()),
    ) {
        headers.insert(name, value);
    }
}

fn request_session_id(headers: &HeaderMap) -> Option<String> {
    ["session_id", "session-id", "x-session-id", "x-session_id"]
        .iter()
        .find_map(|name| header_value(headers, name))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn upstream_headers(
    account: &Account,
    incoming: &HeaderMap,
    url: &str,
    config: &EdgeConfig,
) -> HeaderMap {
    let provider = normalize_provider(account);
    let mut headers = HeaderMap::new();
    set_header(&mut headers, "content-type", "application/json");
    set_header(&mut headers, "accept", "text/event-stream");
    let token = if provider == "opencode" {
        account
            .opencode_api_key
            .as_deref()
            .unwrap_or(&account.access_token)
    } else {
        &account.access_token
    };
    if !token.is_empty() && !is_local_runtime(account) {
        set_header(&mut headers, "authorization", format!("Bearer {token}"));
    }
    if provider == "openai" {
        set_header(&mut headers, "originator", "codex_cli_rs");
        set_header(&mut headers, "user-agent", "codex_cli_rs/0.144.1");
        set_header(&mut headers, "version", "0.144.1");
        set_header(&mut headers, "openai-beta", "responses=experimental");
        if let Some(account_id) = account.chatgpt_account_id.as_deref() {
            set_header(&mut headers, "chatgpt-account-id", account_id);
        }
    } else {
        set_header(&mut headers, "originator", "pi");
        set_header(&mut headers, "user-agent", "pi (multivibe rust edge)");
    }
    if provider == "xai" {
        set_header(&mut headers, "x-xai-token-auth", "xai-grok-cli");
        set_header(&mut headers, "x-grok-client-version", "0.2.114");
        set_header(&mut headers, "x-grok-client-identifier", "grok-pager");
        set_header(&mut headers, "user-agent", "grok-pager/0.2.114");
    }
    if provider == "opencode" {
        for (name, value) in &account.opencode_headers {
            set_header(&mut headers, name, value);
        }
    }
    if let Some(session) = request_session_id(incoming) {
        set_header(&mut headers, "session_id", session);
    }
    for name in [
        "openai-beta",
        "oai-client-version",
        "oai-device-id",
        "oai-language",
        "proof-token",
        "x-oai-attestation",
        "x-openai-attestation",
        "x-openai-browser-token",
        "x-openai-sentinel",
        "x-proof-token",
        "x-codex-turn-state",
        "x-multivibe-priority",
        "x-multivibe-execution",
    ] {
        if let Some(value) = header_value(incoming, name) {
            set_header(&mut headers, name, value);
        }
    }
    let _ = url;
    let _ = config;
    headers
}

fn filter_unsupported_tools(payload: &mut Value, provider: &str) {
    if provider != "openai-compatible" && provider != "opencode" {
        return;
    }
    let became_empty = payload
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .map(|tools| {
            tools.retain(|tool| tool.get("type").and_then(Value::as_str) == Some("function"));
            tools.is_empty()
        })
        .unwrap_or(false);
    if became_empty {
        if let Some(object) = payload.as_object_mut() {
            object.remove("tools");
            if matches!(
                object.get("tool_choice").and_then(Value::as_str),
                Some("auto" | "required")
            ) {
                object.remove("tool_choice");
            }
        }
    }
}

fn prepared_payload(
    body: &Value,
    path: &str,
    account: &Account,
    route: &RouteCandidate,
    session_id: Option<&str>,
    client_stream: bool,
    claude_code: bool,
    config: &EdgeConfig,
) -> Value {
    let chat_route = path.contains("chat/completions");
    let messages_route = path.ends_with("/messages");
    let compact = path.ends_with("/responses/compact");
    let sends_chat = resolve_upstream_mode(account, chat_route, compact);
    let mut payload = if sends_chat {
        if chat_route {
            let mut value = body.clone();
            if let Some(object) = value.as_object_mut() {
                object.insert("stream".to_owned(), Value::Bool(client_stream));
            }
            value
        } else {
            responses_to_chat_completions(body, client_stream)
        }
    } else if chat_route {
        chat_completions_to_responses(body, session_id)
    } else if messages_route {
        normalize_responses_payload(
            &anthropic_to_responses(body, claude_code, config),
            session_id,
        )
    } else {
        normalize_responses_payload(body, session_id)
    };
    if compact {
        if let Some(object) = payload.as_object_mut() {
            for key in [
                "store",
                "stream",
                "include",
                "tool_choice",
                "parallel_tool_calls",
            ] {
                object.remove(key);
            }
        }
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert("model".to_owned(), Value::String(route.model.clone()));
    }
    filter_unsupported_tools(&mut payload, &normalize_provider(account));
    if sends_chat
        && (normalize_provider(account) == "openai-compatible"
            || normalize_provider(account) == "opencode")
    {
        payload = sanitize_generic_chat_payload(&payload);
    }
    payload
}

fn is_quota_error(status: StatusCode, body: &str) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS
        || body.to_ascii_lowercase().contains("quota")
        || body.to_ascii_lowercase().contains("rate limit")
        || body.to_ascii_lowercase().contains("usage limit")
        || body.to_ascii_lowercase().contains("capacity")
        || body.contains("1304")
        || body.contains("1305")
        || body.contains("1308")
        || body.contains("1309")
        || body.contains("1310")
        || body.contains("1312")
        || body.contains("1313")
}

fn should_retry_status(status: StatusCode, body: &str) -> bool {
    is_quota_error(status, body)
        || matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::BAD_GATEWAY
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT
        )
}

fn copy_public_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&name.as_str()) || name == "content-encoding" {
                return None;
            }
            Some((name, value.to_str().ok()?.to_owned()))
        })
        .collect()
}

fn response_from_buffer(reply: BufferedReply) -> Response {
    let mut builder = Response::builder().status(reply.status);
    for (name, value) in reply.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from(reply.body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn set_response_headers(
    mut builder: http::response::Builder,
    headers: &[(String, String)],
) -> http::response::Builder {
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::try_from(name.as_str()),
            HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    builder
}

fn transform_for(
    path: &str,
    account: &Account,
    client_stream: bool,
    content_type: &str,
) -> StreamTransform {
    if !client_stream
        || !content_type
            .to_ascii_lowercase()
            .contains("text/event-stream")
    {
        return StreamTransform::None;
    }
    let client_chat = path.contains("chat/completions");
    let messages = path.ends_with("/messages");
    let sends_chat =
        resolve_upstream_mode(account, client_chat, path.ends_with("/responses/compact"));
    if messages {
        return StreamTransform::ResponseToAnthropic;
    }
    if client_chat && !sends_chat {
        StreamTransform::ResponseToChat
    } else if !client_chat && sends_chat {
        StreamTransform::ChatToResponse
    } else {
        StreamTransform::None
    }
}

async fn proxy_inference(
    state: &EdgeState,
    path: &str,
    headers: &HeaderMap,
    body: &Value,
    application: &str,
) -> Result<ProxyResult, Response> {
    let started_at = now_ms();
    let store = state.store.snapshot().await.map_err(|error| {
        error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable")
    })?;
    let requested_model = value_string(body.get("model")).unwrap_or_default();
    let default_model = state
        .config
        .proxy_models
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    let routes = routes_for_model(&store, &requested_model, default_model);
    let client_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let session_id = request_session_id(headers);
    let mut last_status = StatusCode::SERVICE_UNAVAILABLE;
    let mut last_error = "no eligible account configured".to_owned();
    let mut attempted = 0_usize;
    let mut had_account = false;

    for route in routes {
        if attempted >= state.config.max_account_retry_attempts {
            break;
        }
        let blocked = state.blocked.lock().await.clone();
        let selected = state.selected.lock().await.clone();
        let accounts = select_accounts(
            &store.accounts,
            &RouteCandidate {
                requested_model: route.requested_model.clone(),
                model: route.model.clone(),
                provider: route.provider.clone(),
            },
            &blocked,
            &selected,
        );
        if accounts.is_empty() {
            continue;
        }
        had_account = true;
        for account in accounts {
            if attempted >= state.config.max_account_retry_attempts {
                break;
            }
            attempted += 1;
            let provider = normalize_provider(&account);
            let sends_chat = resolve_upstream_mode(
                &account,
                path.contains("chat/completions"),
                path.ends_with("/responses/compact"),
            );
            let payload = prepared_payload(
                body,
                path,
                &account,
                &route,
                session_id.as_deref(),
                client_stream,
                is_claude_code_request(headers),
                &state.config,
            );
            let url = upstream_url(
                &account,
                &state.config,
                sends_chat,
                path.ends_with("/responses/compact"),
            );
            let serialized = match serde_json::to_vec(&payload) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        error.to_string(),
                        "invalid_request_error",
                    ));
                }
            };
            let request = state
                .client
                .request(Method::POST, &url)
                .headers(upstream_headers(&account, headers, &url, &state.config))
                .body(serialized);
            let response = match timeout(state.config.upstream_timeout, request.send()).await {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    last_status = StatusCode::BAD_GATEWAY;
                    last_error = error.to_string();
                    state
                        .mark_blocked(&account, &route.model, Duration::from_secs(5))
                        .await;
                    continue;
                }
                Err(_) => {
                    last_status = StatusCode::GATEWAY_TIMEOUT;
                    last_error = "upstream request timed out".to_owned();
                    state
                        .mark_blocked(&account, &route.model, Duration::from_secs(5))
                        .await;
                    continue;
                }
            };
            last_status = response.status();
            let response_headers = copy_public_headers(response.headers());
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if !response.status().is_success() {
                let bytes = response.bytes().await.unwrap_or_default();
                let text = String::from_utf8_lossy(&bytes).to_string();
                last_error = if text.is_empty() {
                    format!("upstream returned HTTP {}", response.status())
                } else {
                    text.chars().take(500).collect()
                };
                if should_retry_status(response.status(), &text) {
                    state
                        .mark_blocked(
                            &account,
                            &route.model,
                            if is_quota_error(response.status(), &text) {
                                Duration::from_secs(60)
                            } else {
                                Duration::from_secs(5)
                            },
                        )
                        .await;
                    continue;
                }
                let body = if path.ends_with("/messages") {
                    serde_json::to_vec(&anthropic_error_value(response.status(), &text))
                        .unwrap_or_else(|_| b"{}".to_vec())
                } else {
                    bytes.to_vec()
                };
                state
                    .trace
                    .record(
                        path,
                        application,
                        Some(&account),
                        response.status().as_u16(),
                        client_stream,
                        started_at,
                        Some(&last_error),
                    )
                    .await;
                return Ok(ProxyResult::Buffered(BufferedReply {
                    status: response.status(),
                    headers: response_headers,
                    body: Bytes::from(body),
                }));
            }
            state
                .selected
                .lock()
                .await
                .insert(provider, account.id.clone());
            let transform = transform_for(path, &account, client_stream, &content_type);
            if transform != StreamTransform::None {
                state
                    .trace
                    .record(
                        path,
                        application,
                        Some(&account),
                        response.status().as_u16(),
                        true,
                        started_at,
                        None,
                    )
                    .await;
                return Ok(ProxyResult::Streaming(StreamingReply {
                    status: response.status(),
                    headers: response_headers,
                    upstream: response,
                    transform,
                    requested_model: requested_model.clone().if_empty_then(default_model),
                }));
            }
            let bytes = response.bytes().await.unwrap_or_default();
            let reply = render_buffered_success(
                path,
                &account,
                client_stream,
                &requested_model.clone().if_empty_then(default_model),
                &content_type,
                &bytes,
                response_headers,
            );
            state
                .trace
                .record(
                    path,
                    application,
                    Some(&account),
                    reply.status.as_u16(),
                    client_stream,
                    started_at,
                    None,
                )
                .await;
            return Ok(ProxyResult::Buffered(reply));
        }
    }
    state
        .trace
        .record(
            path,
            application,
            None,
            last_status.as_u16(),
            client_stream,
            started_at,
            Some(&last_error),
        )
        .await;
    let status = if had_account {
        last_status
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    Err(error_response(
        status,
        last_error,
        if had_account {
            "upstream_error"
        } else {
            "no_accounts"
        },
    ))
}

trait EmptyStringFallback {
    fn if_empty_then<'a>(self, fallback: &'a str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty_then<'a>(self, fallback: &'a str) -> String {
        if self.trim().is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

fn anthropic_error_value(status: StatusCode, message: &str) -> Value {
    let kind = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        "authentication_error"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limit_error"
    } else if status == StatusCode::SERVICE_UNAVAILABLE || status.as_u16() == 529 {
        "overloaded_error"
    } else if status.is_client_error() {
        "invalid_request_error"
    } else {
        "api_error"
    };
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

fn anthropic_stream_from_response(response: &Value, requested_model: &str) -> String {
    let message = responses_to_anthropic(response, requested_model);
    let mut output = String::new();
    output.push_str(&sse_frame(
        "message_start",
        &json!({"type": "message_start", "message": {
            "id": message.get("id"),
            "type": "message",
            "role": "assistant",
            "model": requested_model,
            "content": [],
            "stop_reason": Value::Null,
            "stop_sequence": Value::Null,
            "usage": {"input_tokens": message["usage"]["input_tokens"], "output_tokens": 0}
        }}),
    ));
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for (index, part) in content.iter().enumerate() {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                output.push_str(&sse_frame(
                    "content_block_start",
                    &json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_delta",
                    &json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": part.get("text")}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            } else if part.get("type").and_then(Value::as_str) == Some("tool_use") {
                output.push_str(&sse_frame(
                    "content_block_start",
                    &json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": part.get("id"), "name": part.get("name"), "input": {}}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_delta",
                    &json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": part.get("input").map(json_string).unwrap_or_else(|| "{}".to_owned())}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            }
        }
    }
    output.push_str(&sse_frame(
        "message_delta",
        &json!({"type": "message_delta", "delta": {"stop_reason": message.get("stop_reason"), "stop_sequence": Value::Null}, "usage": {"output_tokens": message["usage"]["output_tokens"]}}),
    ));
    output.push_str(&sse_frame("message_stop", &json!({"type": "message_stop"})));
    output
}

fn render_buffered_success(
    path: &str,
    _account: &Account,
    client_stream: bool,
    model: &str,
    content_type: &str,
    bytes: &Bytes,
    mut upstream_headers: Vec<(String, String)>,
) -> BufferedReply {
    let text = String::from_utf8_lossy(bytes).to_string();
    let is_sse = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
        || text.contains("data:");
    let parsed = if is_sse {
        None
    } else {
        serde_json::from_slice::<Value>(bytes).ok()
    };
    let client_chat = path.contains("chat/completions");
    let messages = path.ends_with("/messages");
    let mut output = if client_chat {
        if let Some(value) = parsed.as_ref() {
            if value.get("object").and_then(Value::as_str) == Some("chat.completion") {
                sanitize_chat(value)
            } else if value.get("object").and_then(Value::as_str) == Some("response") {
                response_to_chat(value, model)
            } else {
                value.clone()
            }
        } else if is_sse && text.contains("chat.completion.chunk") {
            chat_from_sse(&text, model)
        } else if is_sse {
            response_to_chat(&response_from_sse(&text, model), model)
        } else {
            json!({"error": "upstream returned invalid JSON"})
        }
    } else if let Some(value) = parsed.as_ref() {
        if value.get("object").and_then(Value::as_str) == Some("response") {
            sanitize_response(value)
        } else if value.get("object").and_then(Value::as_str) == Some("chat.completion") {
            chat_to_response(value, model)
        } else {
            value.clone()
        }
    } else if is_sse && text.contains("chat.completion.chunk") {
        chat_to_response(&chat_from_sse(&text, model), model)
    } else if is_sse {
        response_from_sse(&text, model)
    } else {
        json!({"error": "upstream returned invalid JSON"})
    };

    if messages {
        if parsed.is_none() && is_sse {
            output = response_from_sse(&text, model);
        }
        if client_stream {
            upstream_headers.retain(|(name, _)| name != "content-type");
            upstream_headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
            return BufferedReply {
                status: StatusCode::OK,
                headers: upstream_headers,
                body: Bytes::from(anthropic_stream_from_response(&output, model)),
            };
        }
        output = responses_to_anthropic(&output, model);
    } else if client_stream {
        upstream_headers.retain(|(name, _)| name != "content-type");
        upstream_headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
        if client_chat {
            output = sanitize_chat(&output);
            return BufferedReply {
                status: StatusCode::OK,
                headers: upstream_headers,
                body: Bytes::from(chat_completion_sse(&output)),
            };
        }
        return BufferedReply {
            status: StatusCode::OK,
            headers: upstream_headers,
            body: Bytes::from(response_completed_sse(&output)),
        };
    }
    upstream_headers.retain(|(name, _)| name != "content-type");
    upstream_headers.push(("content-type".to_owned(), "application/json".to_owned()));
    BufferedReply {
        status: StatusCode::OK,
        headers: upstream_headers,
        body: Bytes::from(serde_json::to_vec(&output).unwrap_or_else(|_| b"{}".to_vec())),
    }
}

#[derive(Default)]
struct ChatResponseStreamState {
    response_id: String,
    output_item_id: String,
    model: String,
    created: u64,
    content: String,
    created_sent: bool,
    content_started: bool,
    completed_sent: bool,
    tool_calls: Vec<Value>,
}

impl ChatResponseStreamState {
    fn new(model: &str) -> Self {
        Self {
            response_id: new_id("resp"),
            output_item_id: new_id("msg"),
            model: model.to_owned(),
            created: now_ms() / 1000,
            ..Default::default()
        }
    }

    fn created_frame(&mut self) -> String {
        if self.created_sent {
            return String::new();
        }
        self.created_sent = true;
        sse_frame(
            "response.created",
            &json!({"type": "response.created", "response": {"id": self.response_id, "object": "response", "created_at": self.created, "model": self.model, "status": "in_progress"}}),
        )
    }

    fn finish(&mut self) -> String {
        if self.completed_sent {
            return String::new();
        }
        self.completed_sent = true;
        let mut output = Vec::new();
        if !self.content.is_empty() {
            output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": self.content}]}));
        }
        output.extend(self.tool_calls.clone());
        if output.is_empty() {
            output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ""}]}));
        }
        let response = json!({"id": self.response_id, "object": "response", "created_at": self.created, "model": self.model, "status": "completed", "output": output, "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}});
        let mut out = String::new();
        if self.content_started {
            out.push_str(&sse_frame("response.output_text.done", &json!({"type": "response.output_text.done", "item_id": self.output_item_id, "output_index": 0, "content_index": 0, "text": self.content})));
            out.push_str(&sse_frame("response.content_part.done", &json!({"type": "response.content_part.done", "item_id": self.output_item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": self.content}})));
            out.push_str(&sse_frame("response.output_item.done", &json!({"type": "response.output_item.done", "output_index": 0, "item": {"id": self.output_item_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": self.content}]}})));
        }
        out.push_str(&response_completed_sse(&response));
        out
    }
}

#[derive(Default)]
struct ResponseChatStreamState {
    id: String,
    model: String,
    created: u64,
    role_sent: bool,
    content: String,
    finished: bool,
    tool_call_index: usize,
}

impl ResponseChatStreamState {
    fn new(model: &str) -> Self {
        Self {
            id: new_id("chatcmpl"),
            model: model.to_owned(),
            created: now_ms() / 1000,
            ..Default::default()
        }
    }

    fn chunk(&mut self, delta: Value, finish_reason: Option<&str>) -> String {
        let mut delta_object = object_value(&delta);
        if !self.role_sent {
            self.role_sent = true;
            delta_object.insert("role".to_owned(), Value::String("assistant".to_owned()));
        }
        let value = json!({"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model, "choices": [{"index": 0, "delta": Value::Object(delta_object), "finish_reason": finish_reason}]});
        format!("data: {}\n\n", value)
    }

    fn finish(&mut self) -> String {
        if self.finished {
            return String::new();
        }
        self.finished = true;
        let mut out = self.chunk(json!({}), Some("stop"));
        out.push_str("data: [DONE]\n\n");
        out
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    started: bool,
    model: String,
    message_id: String,
    next_index: usize,
    blocks: HashMap<String, usize>,
    stopped: bool,
}

impl AnthropicStreamState {
    fn new(model: &str) -> Self {
        Self {
            model: model.to_owned(),
            message_id: new_id("msg"),
            ..Default::default()
        }
    }

    fn start(&mut self) -> String {
        if self.started {
            return String::new();
        }
        self.started = true;
        sse_frame(
            "message_start",
            &json!({"type": "message_start", "message": {"id": self.message_id, "type": "message", "role": "assistant", "model": self.model, "content": [], "stop_reason": Value::Null, "stop_sequence": Value::Null, "usage": {"input_tokens": 0, "output_tokens": 0}}}),
        )
    }

    fn stop(&mut self) -> String {
        if self.stopped {
            return String::new();
        }
        self.stopped = true;
        let mut out = String::new();
        out.push_str(&sse_frame("message_delta", &json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": Value::Null}, "usage": {"output_tokens": 0}})));
        out.push_str(&sse_frame("message_stop", &json!({"type": "message_stop"})));
        out
    }
}

struct SseStreamTransformer {
    mode: StreamTransform,
    requested_model: String,
    buffer: String,
    chat_response: ChatResponseStreamState,
    response_chat: ResponseChatStreamState,
    anthropic: AnthropicStreamState,
}

impl SseStreamTransformer {
    fn new(mode: StreamTransform, model: &str) -> Self {
        Self {
            mode,
            requested_model: model.to_owned(),
            buffer: String::new(),
            chat_response: ChatResponseStreamState::new(model),
            response_chat: ResponseChatStreamState::new(model),
            anthropic: AnthropicStreamState::new(model),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut output = String::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let frame = self.buffer[..index].to_owned();
            self.buffer.drain(..index + 2);
            output.push_str(&self.transform_frame(&frame));
        }
        output
    }

    fn finish(&mut self) -> String {
        let mut output = String::new();
        if !self.buffer.trim().is_empty() {
            let frame = std::mem::take(&mut self.buffer);
            output.push_str(&self.transform_frame(&frame));
        }
        match self.mode {
            StreamTransform::ChatToResponse => output.push_str(&self.chat_response.finish()),
            StreamTransform::ResponseToChat => output.push_str(&self.response_chat.finish()),
            StreamTransform::ResponseToAnthropic => output.push_str(&self.anthropic.stop()),
            StreamTransform::None => {}
        }
        output
    }

    fn transform_frame(&mut self, frame: &str) -> String {
        let mut data = Vec::new();
        for line in frame.replace('\r', "").lines() {
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim());
            }
        }
        if data.is_empty() {
            return String::new();
        }
        let payload = data.join("\n");
        if payload == "[DONE]" {
            return match self.mode {
                StreamTransform::ChatToResponse => self.chat_response.finish(),
                StreamTransform::ResponseToChat => self.response_chat.finish(),
                StreamTransform::ResponseToAnthropic => self.anthropic.stop(),
                StreamTransform::None => format!("{frame}\n\n"),
            };
        }
        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
            return String::new();
        };
        match self.mode {
            StreamTransform::ChatToResponse => self.transform_chat_chunk(&value),
            StreamTransform::ResponseToChat => self.transform_response_event(&value),
            StreamTransform::ResponseToAnthropic => self.transform_anthropic_event(&value),
            StreamTransform::None => format!("{frame}\n\n"),
        }
    }

    fn transform_chat_chunk(&mut self, value: &Value) -> String {
        if value.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
            return String::new();
        }
        let mut output = self.chat_response.created_frame();
        let choice = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        let Some(choice) = choice else {
            return output;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(content) = value_string(delta.get("content")) {
                if !self.chat_response.content_started {
                    self.chat_response.content_started = true;
                    output.push_str(&sse_frame("response.output_item.added", &json!({"type": "response.output_item.added", "output_index": 0, "item": {"id": self.chat_response.output_item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}})));
                    output.push_str(&sse_frame("response.content_part.added", &json!({"type": "response.content_part.added", "item_id": self.chat_response.output_item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": ""}})));
                }
                self.chat_response.content.push_str(&content);
                output.push_str(&sse_frame("response.output_text.delta", &json!({"type": "response.output_text.delta", "item_id": self.chat_response.output_item_id, "output_index": 0, "content_index": 0, "delta": content})));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(self.chat_response.tool_calls.len() as u64)
                        as usize;
                    while self.chat_response.tool_calls.len() <= index {
                        self.chat_response.tool_calls.push(json!({"type": "function_call", "id": new_id("call"), "call_id": new_id("call"), "name": "unknown", "arguments": ""}));
                    }
                    let state = &mut self.chat_response.tool_calls[index];
                    if let Some(id) = value_string(call.get("id")) {
                        state["id"] = Value::String(id.clone());
                        state["call_id"] = Value::String(id);
                    }
                    if let Some(function) = call.get("function") {
                        if let Some(name) = value_string(function.get("name")) {
                            state["name"] = Value::String(name);
                        }
                        if let Some(arguments) = value_string(function.get("arguments")) {
                            let previous = state
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            state["arguments"] = Value::String(format!("{previous}{arguments}"));
                            output.push_str(&sse_frame("response.function_call_arguments.delta", &json!({"type": "response.function_call_arguments.delta", "item_id": state.get("id"), "output_index": index, "delta": arguments})));
                        }
                    }
                }
            }
        }
        if let Some(reason) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| value_string(choice.get("finish_reason")))
        {
            if reason != "" {
                output.push_str(&self.chat_response.finish());
            }
        }
        if let Some(usage) = value.get("usage") {
            let _ = usage;
        }
        output
    }

    fn transform_response_event(&mut self, value: &Value) -> String {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "response.created" {
            if let Some(response) = value.get("response") {
                if let Some(id) = value_string(response.get("id")) {
                    self.response_chat.id = id;
                }
                if let Some(model) = value_string(response.get("model")) {
                    self.response_chat.model = model;
                }
                if let Some(created) = response.get("created_at").and_then(Value::as_u64) {
                    self.response_chat.created = created;
                }
            }
            return String::new();
        }
        if event_type == "response.output_text.delta" {
            let text = value_string(value.get("delta")).unwrap_or_default();
            if text.is_empty() {
                return String::new();
            }
            self.response_chat.content.push_str(&text);
            return self.response_chat.chunk(json!({"content": text}), None);
        }
        if event_type == "response.output_text.done" && self.response_chat.content.is_empty() {
            if let Some(text) = value_string(value.get("text")) {
                self.response_chat.content.push_str(&text);
                return self.response_chat.chunk(json!({"content": text}), None);
            }
        }
        if event_type == "response.function_call_arguments.delta" {
            let id = value_string(value.get("item_id")).unwrap_or_else(|| new_id("call"));
            let delta = value_string(value.get("delta")).unwrap_or_default();
            let output = self.response_chat.chunk(json!({"tool_calls": [{"index": self.response_chat.tool_call_index, "id": id, "type": "function", "function": {"arguments": delta}}]}), None);
            self.response_chat.tool_call_index += 1;
            return output;
        }
        if matches!(
            event_type,
            "response.completed" | "response.failed" | "response.incomplete" | "error"
        ) {
            return self.response_chat.finish();
        }
        String::new()
    }

    fn transform_anthropic_event(&mut self, value: &Value) -> String {
        let mut output = self.anthropic.start();
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "response.output_item.added" => {
                let item = value.get("item").unwrap_or(&Value::Null);
                let key = value_string(item.get("id"))
                    .or_else(|| value_string(value.get("item_id")))
                    .unwrap_or_else(|| format!("block-{}", self.anthropic.next_index));
                let index = self.anthropic.next_index;
                self.anthropic.next_index += 1;
                self.anthropic.blocks.insert(key, index);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    output.push_str(&sse_frame("content_block_start", &json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": item.get("call_id").or_else(|| item.get("id")), "name": item.get("name"), "input": {}}})));
                } else {
                    output.push_str(&sse_frame("content_block_start", &json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})));
                }
            }
            "response.output_text.delta" => {
                let key =
                    value_string(value.get("item_id")).unwrap_or_else(|| "block-0".to_owned());
                let index = *self.anthropic.blocks.entry(key).or_insert(0);
                if let Some(text) = value_string(value.get("delta")) {
                    output.push_str(&sse_frame("content_block_delta", &json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}})));
                }
            }
            "response.function_call_arguments.delta" => {
                let key =
                    value_string(value.get("item_id")).unwrap_or_else(|| "block-0".to_owned());
                let index = *self.anthropic.blocks.entry(key).or_insert(0);
                if let Some(delta) = value_string(value.get("delta")) {
                    output.push_str(&sse_frame("content_block_delta", &json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": delta}})));
                }
            }
            "response.output_item.done" => {
                let key = value_string(value.get("item_id"))
                    .or_else(|| {
                        value
                            .get("item")
                            .and_then(|item| value_string(item.get("id")))
                    })
                    .unwrap_or_else(|| "block-0".to_owned());
                if let Some(index) = self.anthropic.blocks.get(&key) {
                    output.push_str(&sse_frame(
                        "content_block_stop",
                        &json!({"type": "content_block_stop", "index": index}),
                    ));
                }
            }
            "response.completed" | "response.failed" | "response.incomplete" | "error" => {
                output.push_str(&self.anthropic.stop())
            }
            _ => {}
        }
        output
    }
}

fn streaming_response(reply: StreamingReply) -> Response {
    let mut builder = Response::builder().status(reply.status);
    let mut headers = reply.headers;
    if reply.transform != StreamTransform::None {
        headers.retain(|(name, _)| name != "content-type");
        headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
    }
    builder = set_response_headers(builder, &headers);
    let transform = reply.transform;
    let model = reply.requested_model;
    let mut upstream = reply.upstream.bytes_stream();
    let body = stream! {
        if transform == StreamTransform::None {
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(chunk) => yield Ok::<Bytes, Infallible>(chunk),
                    Err(_) => break,
                }
            }
        } else {
            let mut converter = SseStreamTransformer::new(transform, &model);
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(chunk) => {
                        let output = converter.push(&chunk);
                        if !output.is_empty() { yield Ok::<Bytes, Infallible>(Bytes::from(output)); }
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let output = if transform == StreamTransform::ResponseToAnthropic {
                            format!("event: error\ndata: {}\n\n", json!({"type": "error", "error": {"type": "api_error", "message": message}}))
                        } else {
                            format!("data: {}\n\ndata: [DONE]\n\n", json!({"error": {"message": message, "type": "upstream_error", "code": "stream_interrupted"}}))
                        };
                        yield Ok::<Bytes, Infallible>(Bytes::from(output));
                        break;
                    }
                }
            }
            let output = converter.finish();
            if !output.is_empty() { yield Ok::<Bytes, Infallible>(Bytes::from(output)); }
        }
    };
    builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Job {
    id: String,
    application: String,
    route: String,
    #[serde(default)]
    request_headers: HashMap<String, String>,
    request_body: Value,
    status: String,
    priority: String,
    model: Option<String>,
    created_at: u64,
    updated_at: u64,
    not_before: u64,
    deadline_at: Option<u64>,
    attempts: u32,
    response_status: Option<u16>,
    response_headers: Option<Vec<(String, String)>>,
    result: Option<Value>,
    error: Option<String>,
    consumed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct JobEvent {
    id: u64,
    #[serde(rename = "jobId")]
    job_id: String,
    application: String,
    r#type: String,
    data: Value,
}

struct JobState {
    jobs: HashMap<String, Job>,
    next_event_id: u64,
}

pub struct JobManager {
    path: PathBuf,
    state: Mutex<JobState>,
    events: broadcast::Sender<JobEvent>,
}

impl JobManager {
    async fn new(path: PathBuf) -> Result<Self, String> {
        let (events, _) = broadcast::channel(256);
        let jobs = match fs::read(&path).await {
            Ok(raw) => serde_json::from_slice::<Vec<Job>>(&raw).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        Ok(Self {
            path,
            state: Mutex::new(JobState {
                jobs: jobs.into_iter().map(|job| (job.id.clone(), job)).collect(),
                next_event_id: 1,
            }),
            events,
        })
    }

    async fn persist(&self) {
        let jobs = {
            let state = self.state.lock().await;
            state.jobs.values().cloned().collect::<Vec<_>>()
        };
        let Ok(raw) = serde_json::to_vec_pretty(&jobs) else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
        if fs::write(&temporary, raw).await.is_ok() {
            let _ = fs::rename(temporary, &self.path).await;
        }
    }

    async fn emit(&self, job: &Job, event_type: &str, data: Value) {
        let mut state = self.state.lock().await;
        let id = state.next_event_id;
        state.next_event_id += 1;
        let _ = self.events.send(JobEvent {
            id,
            job_id: job.id.clone(),
            application: job.application.clone(),
            r#type: event_type.to_owned(),
            data,
        });
    }

    async fn create(
        &self,
        application: &str,
        route: &str,
        headers: &HeaderMap,
        body: &Value,
    ) -> Job {
        let now = now_ms();
        let job = Job {
            id: new_id("job"),
            application: application.to_owned(),
            route: route.to_owned(),
            request_headers: headers
                .iter()
                .filter_map(|(name, value)| {
                    Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
                })
                .collect(),
            request_body: body.clone(),
            status: "queued".to_owned(),
            priority: header_value(headers, "x-multivibe-priority")
                .unwrap_or_else(|| "batch".to_owned()),
            model: value_string(body.get("model")),
            created_at: now,
            updated_at: now,
            not_before: now,
            deadline_at: header_value(headers, "x-multivibe-deadline")
                .and_then(|value| parse_rfc3339_ms(&value)),
            attempts: 0,
            response_status: None,
            response_headers: None,
            result: None,
            error: None,
            consumed_at: None,
        };
        self.state
            .lock()
            .await
            .jobs
            .insert(job.id.clone(), job.clone());
        self.persist().await;
        self.emit(&job, "job.created", json!({"status": "queued"}))
            .await;
        job
    }

    async fn get_for(&self, application: &str, id: &str) -> Option<Job> {
        self.state
            .lock()
            .await
            .jobs
            .get(id)
            .filter(|job| job.application == application)
            .cloned()
    }

    async fn list_for(&self, application: &str, limit: usize) -> Vec<Job> {
        let mut jobs = self
            .state
            .lock()
            .await
            .jobs
            .values()
            .filter(|job| job.application == application)
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs.truncate(limit.clamp(1, 1000));
        jobs
    }

    async fn set_running(&self, id: &str) -> Option<Job> {
        let job = {
            let mut state = self.state.lock().await;
            let job = state.jobs.get_mut(id)?;
            if job.status != "queued" {
                return None;
            }
            job.status = "running".to_owned();
            job.attempts += 1;
            job.updated_at = now_ms();
            job.clone()
        };
        self.persist().await;
        self.emit(&job, "job.started", json!({"status": "running"}))
            .await;
        Some(job)
    }

    async fn succeed(&self, id: &str, reply: BufferedReply) {
        let job = {
            let mut state = self.state.lock().await;
            let Some(job) = state.jobs.get_mut(id) else {
                return;
            };
            job.status = "succeeded".to_owned();
            job.updated_at = now_ms();
            job.response_status = Some(reply.status.as_u16());
            job.response_headers = Some(reply.headers);
            job.result = serde_json::from_slice(&reply.body).ok();
            job.error = None;
            job.clone()
        };
        self.persist().await;
        self.emit(&job, "job.succeeded", json!({"status": "succeeded"}))
            .await;
    }

    async fn fail(&self, id: &str, message: &str) {
        let job = {
            let mut state = self.state.lock().await;
            let Some(job) = state.jobs.get_mut(id) else {
                return;
            };
            job.status = "failed".to_owned();
            job.updated_at = now_ms();
            job.error = Some(message.to_owned());
            job.clone()
        };
        self.persist().await;
        self.emit(
            &job,
            "job.failed",
            json!({"status": "failed", "error": message}),
        )
        .await;
    }

    async fn cancel(&self, application: &str, id: &str) -> Result<(), StatusCode> {
        let job = {
            let mut state = self.state.lock().await;
            let Some(job) = state.jobs.get_mut(id) else {
                return Err(StatusCode::NOT_FOUND);
            };
            if job.application != application {
                return Err(StatusCode::NOT_FOUND);
            }
            if !matches!(job.status.as_str(), "queued" | "running") {
                return Err(StatusCode::CONFLICT);
            }
            job.status = "cancelled".to_owned();
            job.updated_at = now_ms();
            job.clone()
        };
        self.persist().await;
        self.emit(&job, "job.cancelled", json!({"status": "cancelled"}))
            .await;
        Ok(())
    }

    async fn consume_result(&self, application: &str, id: &str) -> Option<Job> {
        let job = {
            let mut state = self.state.lock().await;
            let job = state.jobs.get_mut(id)?;
            if job.application != application || job.status != "succeeded" {
                return None;
            }
            job.consumed_at = Some(now_ms());
            job.clone()
        };
        self.persist().await;
        Some(job)
    }
}

fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    // The edge only needs deadline ordering. A strict RFC3339 parser is kept
    // dependency-free; invalid values are rejected by the request handler.
    let value = value.trim();
    if value.ends_with('Z') {
        let without_zone = value.trim_end_matches('Z');
        let (date, time) = without_zone.split_once('T')?;
        let mut date_parts = date.split('-').map(|part| part.parse::<u64>().ok());
        let year = date_parts.next()??;
        let month = date_parts.next()??;
        let day = date_parts.next()??;
        let time = time.split('.').next()?;
        let mut time_parts = time.split(':').map(|part| part.parse::<u64>().ok());
        let hour = time_parts.next()??;
        let minute = time_parts.next()??;
        let second = time_parts.next()??;
        // Howard Hinnant's civil-date conversion, expressed without a date
        // dependency so the edge stays small.
        let adjusted_year = year - u64::from(month <= 2);
        let era = adjusted_year / 400;
        let year_of_era = adjusted_year - era * 400;
        let month_index = month as i64 + if month > 2 { -3 } else { 9 };
        let day_of_year = (153 * month_index + 2) / 5 + day as i64 - 1;
        let day_of_era =
            year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year as u64;
        Some(
            ((era * 146097 + day_of_era - 719468) * 86_400 + hour * 3600 + minute * 60 + second)
                * 1000,
        )
    } else {
        None
    }
}

fn public_job(job: &Job) -> Value {
    let mut value = json!({
        "object": "multivibe.job",
        "id": job.id,
        "status": job.status,
        "priority": job.priority,
        "model": job.model,
        "attempts": job.attempts,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "not_before": job.not_before,
        "result_url": format!("/v1/jobs/{}/result", job.id),
        "events_url": format!("/v1/jobs/{}/events", job.id),
        "error": job.error,
    });
    if let Some(deadline) = job.deadline_at {
        value["deadline"] = Value::Number(deadline.into());
    }
    value
}

async fn run_job(state: EdgeState, job: Job) {
    let Some(running) = state.jobs.set_running(&job.id).await else {
        return;
    };
    let headers = running
        .request_headers
        .iter()
        .filter_map(|(name, value)| {
            Some((
                HeaderName::try_from(name).ok()?,
                HeaderValue::from_str(value).ok()?,
            ))
        })
        .collect::<HeaderMap>();
    match proxy_inference(
        &state,
        &running.route,
        &headers,
        &running.request_body,
        &running.application,
    )
    .await
    {
        Ok(ProxyResult::Buffered(reply)) => state.jobs.succeed(&running.id, reply).await,
        Ok(ProxyResult::Streaming(_)) => {
            state
                .jobs
                .fail(&running.id, "deferred jobs cannot return a stream")
                .await
        }
        Err(_error) => {
            state
                .jobs
                .fail(&running.id, "deferred inference failed")
                .await
        }
    }
}

fn idempotency_key(path: &str, application: &str, key: &str, body: &Value) -> String {
    let serialized = serde_json::to_vec(body).unwrap_or_default();
    let digest = Sha256::digest(serialized);
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{application}:{path}:{key}:{digest}")
}

fn safe_job_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let normalized = name.as_str();
        if matches!(
            normalized,
            "authorization" | "x-api-key" | "api-key" | "cookie" | "host" | "content-length"
        ) {
            continue;
        }
        if normalized.starts_with("x-multivibe-internal") {
            continue;
        }
        result.insert(name.clone(), value.clone());
    }
    result
}

fn add_decision_headers(reply: &mut BufferedReply, priority: Option<&str>, model: &str) {
    reply.headers.retain(|(name, _)| {
        !matches!(
            name.as_str(),
            "x-multivibe-decision" | "x-multivibe-priority" | "x-multivibe-resolved-model"
        )
    });
    reply
        .headers
        .push(("x-multivibe-decision".to_owned(), "cloud".to_owned()));
    reply.headers.push((
        "x-multivibe-priority".to_owned(),
        priority.unwrap_or("standard").to_owned(),
    ));
    if !model.is_empty() {
        reply
            .headers
            .push(("x-multivibe-resolved-model".to_owned(), model.to_owned()));
    }
}

async fn inference_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let request_headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&request_headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let (headers, body, _) = match read_json_body(
        req,
        if path.ends_with("/messages") {
            state.config.request_body_limit.min(100 * 1024 * 1024)
        } else {
            state.config.request_body_limit
        },
        path.ends_with("/messages"),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let client_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let raw_execution = header_value(&headers, "x-multivibe-execution");
    if let Some(execution) = raw_execution.as_deref() {
        if !matches!(execution, "sync" | "auto" | "defer") {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid X-MultiVibe-Execution",
                "invalid_execution",
            );
        }
    }
    if client_stream && raw_execution.as_deref() == Some("defer") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Streaming, WebSocket and Realtime requests cannot be deferred.",
            "stream_cannot_be_deferred",
        );
    }
    let model = value_string(body.get("model")).unwrap_or_else(|| {
        state
            .config
            .proxy_models
            .first()
            .cloned()
            .unwrap_or_default()
    });
    let request_idempotency = header_value(&headers, "x-multivibe-idempotency-key");
    let cache_key = request_idempotency
        .as_deref()
        .filter(|_| !client_stream)
        .map(|key| idempotency_key(&path, &auth.application, key, &body));
    if let Some(key) = cache_key.as_deref() {
        if let Some(reply) = state.cached_idempotency(key).await {
            return response_from_buffer(reply);
        }
    }
    if raw_execution.as_deref() == Some("defer") {
        let job_headers = safe_job_headers(&headers);
        let job = state
            .jobs
            .create(&auth.application, &path, &job_headers, &body)
            .await;
        let response = json_response(StatusCode::ACCEPTED, public_job(&job));
        let state_for_job = state.clone();
        tokio::spawn(run_job(state_for_job, job));
        return response;
    }
    match proxy_inference(&state, &path, &headers, &body, &auth.application).await {
        Ok(ProxyResult::Buffered(mut reply)) => {
            add_decision_headers(
                &mut reply,
                header_value(&headers, "x-multivibe-priority").as_deref(),
                &model,
            );
            if let Some(key) = cache_key {
                state.store_idempotency(key, &reply).await;
            }
            response_from_buffer(reply)
        }
        Ok(ProxyResult::Streaming(mut reply)) => {
            // Decision headers are added before the streaming body is exposed.
            reply.headers.retain(|(name, _)| {
                !matches!(
                    name.as_str(),
                    "x-multivibe-decision" | "x-multivibe-priority" | "x-multivibe-resolved-model"
                )
            });
            reply
                .headers
                .push(("x-multivibe-decision".to_owned(), "cloud".to_owned()));
            reply.headers.push((
                "x-multivibe-priority".to_owned(),
                header_value(&headers, "x-multivibe-priority")
                    .unwrap_or_else(|| "standard".to_owned()),
            ));
            if !model.is_empty() {
                reply
                    .headers
                    .push(("x-multivibe-resolved-model".to_owned(), model));
            }
            streaming_response(reply)
        }
        Err(response) => response,
    }
}

async fn method_not_allowed() -> Response {
    error_response(
        StatusCode::METHOD_NOT_ALLOWED,
        "This endpoint only accepts POST requests",
        "method_not_allowed",
    )
}

fn model_entry(
    id: &str,
    provider: &str,
    account_ids: Vec<String>,
    alias: bool,
    alias_targets: Vec<String>,
) -> Value {
    let mut metadata = json!({
        "provider": provider,
        "provider_candidates": [provider],
        "account_ids": account_ids,
        "context_window": Value::Null,
        "max_output_tokens": Value::Null,
        "supports_reasoning": provider == "openai",
        "supports_tools": true,
        "supported_tool_types": ["function"],
    });
    if alias {
        metadata["is_alias"] = Value::Bool(true);
        metadata["alias_targets"] =
            Value::Array(alias_targets.into_iter().map(Value::String).collect());
    }
    json!({"id": id, "object": "model", "created": 0, "owned_by": provider, "metadata": metadata})
}

fn exposed_models(store: &StoreFile, config: &EdgeConfig) -> Vec<Value> {
    let mut ids = Vec::new();
    let mut providers: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for model in &config.proxy_models {
        ids.push((model.clone(), infer_provider(model), false, Vec::new()));
    }
    for account in &store.accounts {
        if !account.enabled {
            continue;
        }
        let provider = normalize_provider(account);
        if let Some(runtime) = account.local_runtime.as_ref() {
            for model in &runtime.confirmed_model_ids {
                ids.push((model.clone(), provider.clone(), false, Vec::new()));
                providers
                    .entry(normalize_model_key(model))
                    .or_insert((provider.clone(), Vec::new()))
                    .1
                    .push(account.id.clone());
            }
        }
    }
    for (id, provider, alias, targets) in ids {
        let entry = providers
            .entry(normalize_model_key(&id))
            .or_insert((provider.clone(), Vec::new()));
        if !entry.1.is_empty() {
            continue;
        }
        entry.0 = provider;
        let _ = alias;
        let _ = targets;
    }
    let mut models = providers
        .into_iter()
        .map(|(_, (provider, account_ids))| (provider, account_ids))
        .enumerate()
        .map(|(index, (provider, account_ids))| {
            let id = if let Some(model) = config.proxy_models.get(index) {
                model.clone()
            } else {
                format!("model-{index}")
            };
            model_entry(&id, &provider, account_ids, false, Vec::new())
        })
        .collect::<Vec<_>>();
    // Rebuild the basic catalog in deterministic order; aliases are appended.
    models.clear();
    let mut seen = HashSet::new();
    for model in &config.proxy_models {
        if seen.insert(normalize_model_key(model)) {
            models.push(model_entry(
                model,
                &infer_provider(model),
                Vec::new(),
                false,
                Vec::new(),
            ));
        }
    }
    for account in &store.accounts {
        if let Some(runtime) = account.local_runtime.as_ref() {
            for model in &runtime.confirmed_model_ids {
                if seen.insert(normalize_model_key(model)) {
                    models.push(model_entry(
                        model,
                        &normalize_provider(account),
                        vec![account.id.clone()],
                        false,
                        Vec::new(),
                    ));
                }
            }
        }
    }
    for alias in store.model_aliases.iter().filter(|alias| alias.enabled) {
        let targets = alias
            .rules
            .iter()
            .flat_map(|rule| {
                rule.candidates
                    .iter()
                    .map(|candidate| candidate.model.clone())
            })
            .collect::<Vec<_>>();
        if targets.is_empty() || !seen.insert(normalize_model_key(&alias.id)) {
            continue;
        }
        models.push(model_entry(
            &alias.id,
            &infer_provider(&targets[0]),
            Vec::new(),
            true,
            targets,
        ));
    }
    models
}

async fn list_models_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, path, &store, &state.config) {
        return response;
    }
    if is_claude_code_request(&headers) {
        return json_response(
            StatusCode::OK,
            json!({"object": "list", "data": [
                {"id": "claude-opus-4-1", "object": "model", "created": 0, "owned_by": "anthropic"},
                {"id": "claude-sonnet-4-5", "object": "model", "created": 0, "owned_by": "anthropic"},
                {"id": "claude-haiku-4-5", "object": "model", "created": 0, "owned_by": "anthropic"}
            ]}),
        );
    }
    let models = exposed_models(&store, &state.config);
    json_response(
        StatusCode::OK,
        json!({"object": "list", "data": models, "models": []}),
    )
}

async fn get_model_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    let model = exposed_models(&store, &state.config)
        .into_iter()
        .find(|model| {
            model
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|value| value == id)
        });
    match model {
        Some(model) => json_response(StatusCode::OK, model),
        None => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": {"message": format!("The model '{id}' does not exist"), "type": "invalid_request_error"}}),
        ),
    }
}

async fn props_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path().to_owned();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, &path, &store, &state.config) {
        return response;
    }
    json_response(
        StatusCode::OK,
        json!({
            "default_model": state.config.proxy_models.first(),
            "models_url": "/v1/models",
        }),
    )
}

#[derive(Debug, Deserialize)]
struct CapacityQuery {
    model: Option<String>,
    priority: Option<String>,
}

async fn capacity_handler(
    State(state): State<EdgeState>,
    Query(query): Query<CapacityQuery>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let Some(model) = query.model.filter(|value| !value.trim().is_empty()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "model query parameter is required"}),
        );
    };
    let priority = query.priority.unwrap_or_else(|| "standard".to_owned());
    if !matches!(
        priority.as_str(),
        "critical" | "interactive" | "standard" | "batch"
    ) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid priority"}),
        );
    }
    let route = RouteCandidate {
        requested_model: model.clone(),
        model: model.clone(),
        provider: Some(infer_provider(&model)),
    };
    let accounts = select_accounts(
        &store.accounts,
        &route,
        &state.blocked.lock().await,
        &state.selected.lock().await,
    );
    let free_slots = accounts
        .iter()
        .map(|account| {
            account
                .capacity_profile
                .as_ref()
                .and_then(|profile| profile.max_concurrent)
                .unwrap_or(1) as u64
        })
        .sum::<u64>();
    let state_name = if accounts.is_empty() {
        "unavailable"
    } else if free_slots > 0 {
        "ready"
    } else {
        "degraded"
    };
    json_response(
        StatusCode::OK,
        json!({
            "object": "multivibe.capacity",
            "model": model,
            "application": auth.application,
            "priority": priority,
            "state": state_name,
            "decision": accounts.first().and_then(|account| account.location.as_deref()).unwrap_or("cloud"),
            "admissibleLocations": accounts.iter().filter_map(|account| account.location.clone()).collect::<Vec<_>>(),
            "freeSlots": free_slots,
            "queueDepth": 0,
            "recommendation": if accounts.is_empty() { "defer" } else { "sync" },
            "version": state.capacity_version.load(AtomicOrdering::Relaxed),
            "generatedAt": now_ms(),
            "confidence": "declared"
        }),
    )
}

async fn capacity_events_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    let body = stream! {
        yield Ok::<Bytes, Infallible>(Bytes::from(format!("id: {}\nevent: capacity.changed\ndata: {}\n\n", state.capacity_version.load(AtomicOrdering::Relaxed), json!({"version": state.capacity_version.load(AtomicOrdering::Relaxed)}))));
        yield Ok::<Bytes, Infallible>(Bytes::from(": heartbeat\n\n"));
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn list_jobs_handler(
    State(state): State<EdgeState>,
    Query(query): Query<HashMap<String, String>>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100);
    let jobs = state.jobs.list_for(&auth.application, limit).await;
    json_response(
        StatusCode::OK,
        json!({"object": "list", "data": jobs.iter().map(public_job).collect::<Vec<_>>() }),
    )
}

async fn get_job_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    match state.jobs.get_for(&auth.application, &id).await {
        Some(job) => json_response(StatusCode::OK, public_job(&job)),
        None => json_response(StatusCode::NOT_FOUND, json!({"error": "not found"})),
    }
}

async fn get_job_result_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let Some(job) = state.jobs.get_for(&auth.application, &id).await else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}));
    };
    if job.status != "succeeded" {
        if matches!(job.status.as_str(), "failed" | "cancelled" | "expired") {
            return json_response(
                StatusCode::GONE,
                json!({"error": job.error.unwrap_or_else(|| format!("job {}", job.status))}),
            );
        }
        return json_response(
            StatusCode::CONFLICT,
            json!({"error": "result is not ready", "job": public_job(&job)}),
        );
    }
    let Some(consumed) = state.jobs.consume_result(&auth.application, &id).await else {
        return json_response(
            StatusCode::CONFLICT,
            json!({"error": "result is not ready"}),
        );
    };
    let mut reply = BufferedReply {
        status: StatusCode::OK,
        headers: consumed.response_headers.unwrap_or_default(),
        body: Bytes::from(
            serde_json::to_vec(&consumed.result.unwrap_or(Value::Null))
                .unwrap_or_else(|_| b"null".to_vec()),
        ),
    };
    reply
        .headers
        .retain(|(name, _)| PUBLIC_RESPONSE_HEADERS.contains(&name.as_str()));
    response_from_buffer(reply)
}

async fn get_job_events_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let Some(job) = state.jobs.get_for(&auth.application, &id).await else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}));
    };
    let body = stream! {
        yield Ok::<Bytes, Infallible>(Bytes::from(format!("id: 1\nevent: job.status\ndata: {}\n\n", json!(public_job(&job)))));
        yield Ok::<Bytes, Infallible>(Bytes::from(": heartbeat\n\n"));
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn delete_job_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    match state.jobs.cancel(&auth.application, &id).await {
        Ok(()) => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty())),
        Err(status) => json_response(
            status,
            if status == StatusCode::NOT_FOUND {
                json!({"error": "not found"})
            } else {
                json!({"error": "job can no longer be cancelled"})
            },
        ),
    }
}

fn realtime_url(account: &Account, config: &EdgeConfig) -> Result<String, String> {
    if let Some(url) = config.realtime_webrtc_call_url.as_deref() {
        return Ok(url.to_owned());
    }
    if config.realtime_provider == "openai-compatible" {
        return account
            .base_url
            .as_deref()
            .map(|url| format!("{}/realtime/calls", trim_slashes(url)))
            .ok_or_else(|| {
                "Realtime OpenAI-compatible account requires a baseUrl or REALTIME_WEBRTC_CALL_URL"
                    .to_owned()
            });
    }
    Ok(format!(
        "{}/backend-api/realtime/calls",
        trim_slashes(&config.chatgpt_base_url)
    ))
}

async fn realtime_call_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let content_type = header_value(&headers, "content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !(content_type.starts_with("multipart/form-data;")
        || content_type.starts_with("application/sdp"))
    {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Realtime call Content-Type must be application/sdp or multipart/form-data",
            "unsupported_media_type",
        );
    }
    let body = match to_bytes(req.into_body(), state.config.realtime_body_limit).await {
        Ok(body) if !body.is_empty() => body,
        Ok(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Realtime call requires an SDP or multipart body",
                "missing_realtime_body",
            );
        }
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Realtime call body is too large",
                "payload_too_large",
            );
        }
    };
    let route = RouteCandidate {
        requested_model: "realtime".to_owned(),
        model: "realtime".to_owned(),
        provider: Some(state.config.realtime_provider.clone()),
    };
    let accounts = select_accounts(
        &store.accounts,
        &route,
        &state.blocked.lock().await,
        &state.selected.lock().await,
    );
    let mut last_error = "no eligible realtime account configured".to_owned();
    for account in accounts {
        let url = match realtime_url(&account, &state.config) {
            Ok(url) => url,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        let mut upstream_headers = upstream_headers(&account, &headers, &url, &state.config);
        set_header(&mut upstream_headers, "content-type", &content_type);
        set_header(
            &mut upstream_headers,
            "accept",
            "application/sdp, application/json",
        );
        let response = match timeout(
            state.config.upstream_timeout,
            state
                .client
                .post(&url)
                .headers(upstream_headers)
                .body(body.clone())
                .send(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                last_error = error.to_string();
                continue;
            }
            Err(_) => {
                last_error = "realtime upstream request timed out".to_owned();
                continue;
            }
        };
        let status = response.status();
        let response_headers = copy_public_headers(response.headers());
        let bytes = response.bytes().await.unwrap_or_default();
        if !status.is_success() && is_quota_error(status, &String::from_utf8_lossy(&bytes)) {
            state
                .mark_blocked(&account, "realtime", Duration::from_secs(60))
                .await;
            last_error = String::from_utf8_lossy(&bytes).chars().take(500).collect();
            continue;
        }
        if !status.is_success()
            && matches!(
                status,
                StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::BAD_GATEWAY
                    | StatusCode::SERVICE_UNAVAILABLE
                    | StatusCode::GATEWAY_TIMEOUT
            )
        {
            last_error = String::from_utf8_lossy(&bytes).chars().take(500).collect();
            continue;
        }
        return response_from_buffer(BufferedReply {
            status,
            headers: response_headers,
            body: Bytes::from(bytes),
        });
    }
    json_response(
        StatusCode::BAD_GATEWAY,
        json!({"error": {"message": last_error, "type": "upstream_error", "code": "realtime_upstream_error", "application": auth.application}}),
    )
}

async fn realtime_voices_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path().to_owned();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, &path, &store, &state.config) {
        return response;
    }
    let route = RouteCandidate {
        requested_model: "realtime-voices".to_owned(),
        model: "realtime-voices".to_owned(),
        provider: Some("openai".to_owned()),
    };
    let Some(account) = select_accounts(
        &store.accounts,
        &route,
        &state.blocked.lock().await,
        &state.selected.lock().await,
    )
    .into_iter()
    .next() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": {"message": "no eligible ChatGPT account configured for voice discovery", "type": "service_unavailable", "code": "voice_account_unavailable"}}),
        );
    };
    let mut url = format!(
        "{}/backend-api/settings/voices",
        trim_slashes(&state.config.chatgpt_base_url)
    );
    if let Some(query) = req.uri().query().filter(|query| !query.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    if !url.contains("voice_mode=") {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str("voice_mode=advanced");
    }
    let response = match timeout(
        state.config.upstream_timeout,
        state
            .client
            .get(&url)
            .headers(upstream_headers(&account, &headers, &url, &state.config))
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                json!({"error": {"message": error.to_string(), "type": "upstream_error", "code": "voice_discovery_upstream_error"}}),
            );
        }
        Err(_) => {
            return json_response(
                StatusCode::GATEWAY_TIMEOUT,
                json!({"error": {"message": "voice discovery upstream request timed out", "type": "upstream_error", "code": "voice_discovery_upstream_error"}}),
            );
        }
    };
    let status = response.status();
    let response_headers = copy_public_headers(response.headers());
    let body = response.bytes().await.unwrap_or_default();
    response_from_buffer(BufferedReply {
        status,
        headers: response_headers,
        body: Bytes::from(body),
    })
}

async fn websocket_handler(
    State(state): State<EdgeState>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response {
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };
    if authorize(&headers, "/v1/responses", &store, &state.config).is_err() {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    ws.on_upgrade(move |socket| handle_websocket(socket, state, headers))
}

async fn ws_send_json(socket: &mut WebSocket, value: Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

async fn handle_websocket(mut socket: WebSocket, state: EdgeState, headers: HeaderMap) {
    while let Some(Ok(message)) = socket.next().await {
        match message {
            Message::Text(text) => {
                let Ok(mut frame) = serde_json::from_str::<Value>(&text) else {
                    if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "code": "invalid_json", "message": "expected a JSON text frame with type='response.create'"}})).await { break; }
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) != Some("response.create") {
                    if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "message": "expected a JSON text frame with type='response.create'"}})).await { break; }
                    continue;
                }
                if frame.get("generate").and_then(Value::as_bool) == Some(false) {
                    let id = new_id("resp");
                    let model = value_string(frame.get("model")).unwrap_or_else(|| "unknown".to_owned());
                    if !ws_send_json(&mut socket, json!({"type": "response.created", "response": {"id": id, "object": "response", "model": model, "status": "in_progress"}})).await { break; }
                    if !ws_send_json(&mut socket, json!({"type": "response.completed", "response": {"id": id, "object": "response", "model": model, "status": "completed", "output": [], "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}})).await { break; }
                    continue;
                }
                if let Some(object) = frame.as_object_mut() {
                    object.remove("type");
                    object.remove("previous_response_id");
                    object.insert("stream".to_owned(), Value::Bool(true));
                }
                match proxy_inference(&state, "/v1/responses", &headers, &frame, "default").await {
                    Ok(ProxyResult::Buffered(reply)) => {
                        if reply.status.is_success() {
                            let text = String::from_utf8_lossy(&reply.body);
                            if text.contains("data:") {
                                for (_, event) in parse_sse_events(&text) {
                                    if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                                }
                            } else if let Ok(response) = serde_json::from_slice::<Value>(&reply.body) {
                                let id = value_string(response.get("id")).unwrap_or_else(|| new_id("resp"));
                                if !ws_send_json(&mut socket, json!({"type": "response.created", "response": {"id": id, "object": "response", "model": response.get("model"), "status": "in_progress"}})).await { return; }
                                if !ws_send_json(&mut socket, json!({"type": "response.completed", "response": response})).await { return; }
                            }
                        } else if !ws_send_json(&mut socket, json!({"type": "error", "status": reply.status.as_u16(), "error": {"type": "upstream_error", "message": String::from_utf8_lossy(&reply.body)}})).await { return; }
                    }
                    Ok(ProxyResult::Streaming(reply)) => {
                        let mut upstream = reply.upstream.bytes_stream();
                        let mut buffer = String::new();
                        while let Some(Ok(chunk)) = upstream.next().await {
                            buffer.push_str(&String::from_utf8_lossy(&chunk));
                            while let Some(index) = buffer.find("\n\n") {
                                let frame = buffer[..index].to_owned();
                                buffer.drain(..index + 2);
                                for (_, event) in parse_sse_events(&format!("{frame}\n\n")) {
                                    if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                                }
                            }
                        }
                        if !buffer.trim().is_empty() {
                            for (_, event) in parse_sse_events(&format!("{buffer}\n\n")) {
                                if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                            }
                        }
                    }
                    Err(_) => {
                        if !ws_send_json(&mut socket, json!({"type": "error", "status": 502, "error": {"type": "upstream_error", "message": "upstream request failed"}})).await { return; }
                    }
                }
            }
            Message::Binary(_) => {
                if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "message": "binary websocket frames are not supported"}})).await { break; }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}

async fn fallback_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    if path == "/v1" || path.starts_with("/v1/") {
        let headers = req.headers().clone();
        let store = match state.store.snapshot().await {
            Ok(store) => store,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
            }
        };
        if let Err(response) = authorize(&headers, &path, &store, &state.config) {
            return response;
        }
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"error": {"message": "Unknown /v1 endpoint", "type": "invalid_request_error", "code": "not_found"}}),
        );
    }
    let target = format!(
        "{}{}",
        trim_slashes(&state.config.node_control_plane_url),
        req.uri()
            .path_and_query()
            .map(|value| value.to_string())
            .unwrap_or_else(|| path.clone()),
    );
    let method = req.method().clone();
    let incoming_headers = req.headers().clone();
    let body = match to_bytes(req.into_body(), state.config.request_body_limit).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body is too large",
                "payload_too_large",
            );
        }
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &incoming_headers {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    let upstream = match timeout(
        state.config.upstream_timeout,
        state
            .client
            .request(method, target)
            .headers(headers)
            .body(body)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                json!({"error": {"message": format!("control-plane unavailable: {error}"), "type": "upstream_error"}}),
            );
        }
        Err(_) => {
            return json_response(
                StatusCode::GATEWAY_TIMEOUT,
                json!({"error": {"message": "control-plane request timed out", "type": "upstream_error"}}),
            );
        }
    };
    let status = upstream.status();
    let mut response_builder = Response::builder().status(status);
    for (name, value) in upstream.headers() {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        response_builder = response_builder.header(name, value);
    }
    let mut body_stream = upstream.bytes_stream();
    let body = stream! {
        while let Some(chunk) = body_stream.next().await {
            if let Ok(chunk) = chunk { yield Ok::<Bytes, Infallible>(chunk); }
        }
    };
    response_builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

pub fn build_router(state: EdgeState) -> Router {
    Router::new()
        .route(
            "/v1/models",
            get(list_models_handler).post(method_not_allowed),
        )
        .route(
            "/v1/models/{id}",
            get(get_model_handler).post(method_not_allowed),
        )
        .route("/v1/props", get(props_handler))
        .route(
            "/v1/responses",
            get(websocket_handler).post(inference_handler),
        )
        .route("/v1/responses/compact", post(inference_handler))
        .route("/v1/chat/completions", post(inference_handler))
        .route("/v1/messages", post(inference_handler))
        .route("/v1/realtime/calls", post(realtime_call_handler))
        .route("/v1/realtime/voices", get(realtime_voices_handler))
        .route("/v1/settings/voices", get(realtime_voices_handler))
        .route("/v1/capacity", get(capacity_handler))
        .route("/v1/capacity/events", get(capacity_events_handler))
        .route("/v1/jobs", get(list_jobs_handler))
        .route(
            "/v1/jobs/{id}",
            get(get_job_handler).delete(delete_job_handler),
        )
        .route("/v1/jobs/{id}/result", get(get_job_result_handler))
        .route("/v1/jobs/{id}/events", get(get_job_events_handler))
        .fallback(fallback_handler)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, routing::post};
    use std::io::Cursor;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "multivibe-v1-edge-{label}-{}",
            Uuid::new_v4().simple()
        ))
    }

    fn account(id: &str) -> Account {
        Account {
            id: id.to_owned(),
            provider: Some("openai".to_owned()),
            access_token: "upstream-token".to_owned(),
            enabled: true,
            ..Default::default()
        }
    }

    fn store_with_accounts(accounts: Vec<Account>) -> StoreFile {
        StoreFile {
            accounts,
            ..Default::default()
        }
    }

    async fn start_server(router: Router) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        tokio::task::yield_now().await;
        (format!("http://{address}"), task)
    }

    #[test]
    fn api_key_authentication_is_constant_time_and_application_scoped() {
        assert!(constant_time_equal("same-key", "same-key"));
        assert!(!constant_time_equal("same-key", "other-key"));

        let mut config = EdgeConfig::default();
        config.configured_api_keys = vec![("interactive".to_owned(), "secret".to_owned())];
        let store = StoreFile::default();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );

        let auth = authorize(&headers, "/v1/responses", &store, &config).unwrap();
        assert_eq!(auth.application, "interactive");

        headers.remove(header::AUTHORIZATION);
        let error = authorize(&headers, "/v1/messages", &store, &config).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn configured_keys_reject_duplicates() {
        let error = parse_configured_api_keys("legacy", r#"{"batch":"legacy"}"#).unwrap_err();
        assert!(error.contains("unique"));

        let parsed = parse_configured_api_keys("", r#"{"batch":"batch-key"}"#).unwrap();
        assert_eq!(parsed, vec![("batch".to_owned(), "batch-key".to_owned())]);
    }

    #[test]
    fn zstd_decompression_is_bounded() {
        let source = br#"{"input":"hello"}"#;
        let compressed = zstd::stream::encode_all(Cursor::new(source), 1).unwrap();
        assert_eq!(decompress_zstd(&compressed, source.len()).unwrap(), source);
        assert!(decompress_zstd(&compressed, source.len() - 1).is_err());
    }

    #[test]
    fn account_selection_balances_usage_and_rotates_ties() {
        let mut first = account("a");
        first.usage = Some(UsageSnapshot {
            secondary: Some(UsageWindow {
                used_percent: Some(70.0),
                ..Default::default()
            }),
            ..Default::default()
        });
        let mut second = account("b");
        second.usage = Some(UsageSnapshot {
            secondary: Some(UsageWindow {
                used_percent: Some(10.0),
                ..Default::default()
            }),
            ..Default::default()
        });
        let route = RouteCandidate {
            requested_model: "gpt-5.3-codex".to_owned(),
            model: "gpt-5.3-codex".to_owned(),
            provider: Some("openai".to_owned()),
        };
        let accounts = vec![first, second];
        let empty = HashMap::new();
        let selected = HashMap::new();
        let ordered = select_accounts(&accounts, &route, &empty, &selected);
        assert_eq!(ordered.first().map(|value| value.id.as_str()), Some("b"));

        let selected = HashMap::from([(String::from("openai"), String::from("b"))]);
        let rotated = select_accounts(&accounts, &route, &empty, &selected);
        assert_eq!(rotated.first().map(|value| value.id.as_str()), Some("a"));

        let mut blocked = account("blocked");
        blocked.state = Some(AccountState {
            auth_blocked_until: Some(now_ms() + 60_000),
            ..Default::default()
        });
        let accounts = vec![blocked];
        assert!(select_accounts(&accounts, &route, &empty, &HashMap::new()).is_empty());
    }

    #[test]
    fn protocol_conversions_preserve_tools_images_and_session_defaults() {
        let chat = json!({
            "model": "gpt-5.3-codex",
            "messages": [
                {"role": "system", "content": "Be concise"},
                {"role": "user", "content": [
                    {"type": "text", "text": "Describe this"},
                    {"type": "image_url", "image_url": {"url": "https://example.test/image.png"}}
                ]},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "lookup", "arguments": "{\"q\":\"rust\"}"}}]},
                {"role": "tool", "tool_call_id": "call-1", "content": "result"}
            ],
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
        });
        let responses = chat_completions_to_responses(&chat, Some("session-1"));
        assert_eq!(responses["store"], false);
        assert_eq!(responses["stream"], true);
        assert_eq!(responses["prompt_cache_key"], "session-1");
        assert_eq!(responses["instructions"], "Be concise");
        assert!(responses["input"].as_array().unwrap().iter().any(|item| {
            item["content"]
                .as_array()
                .unwrap()
                .iter()
                .any(|part| part["type"] == "input_image")
        }));
        assert!(
            responses["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| { item["type"] == "function_call_output" })
        );

        let chat_again = response_to_chat(
            &json!({
                "id": "resp-1",
                "object": "response",
                "model": "gpt-5.3-codex",
                "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}],
                "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
            }),
            "gpt-5.3-codex",
        );
        assert_eq!(chat_again["object"], "chat.completion");
        assert_eq!(chat_again["choices"][0]["message"]["content"], "done");

        let anthropic = anthropic_to_responses(
            &json!({
                "model": "claude-sonnet-4-5",
                "system": "You are helpful",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
            }),
            true,
            &EdgeConfig::default(),
        );
        assert!(!anthropic["model"].as_str().unwrap().contains("claude"));
        assert_eq!(anthropic["instructions"], "You are helpful");
    }

    #[test]
    fn sse_conversion_emits_protocol_specific_completion() {
        let response_sse = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}}\n\n"
        );
        let response = response_from_sse(response_sse, "gpt-5.3-codex");
        assert_eq!(response["id"], "resp-1");
        assert_eq!(response["output"][0]["content"][0]["text"], "hello");

        let chat_sse = concat!(
            "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let chat = chat_from_sse(chat_sse, "gpt-5.3-codex");
        assert_eq!(chat["id"], "chat-1");
        assert_eq!(chat["choices"][0]["message"]["content"], "hello");
    }

    #[tokio::test]
    async fn jobs_are_persisted_and_results_are_application_scoped() {
        let path = temporary_path("jobs");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let job = manager
            .create(
                "batch-app",
                "/v1/responses",
                &HeaderMap::new(),
                &json!({"model": "gpt-5.3-codex", "input": "hello"}),
            )
            .await;
        assert_eq!(job.status, "queued");
        let running = manager.set_running(&job.id).await.unwrap();
        assert_eq!(running.status, "running");
        manager
            .succeed(
                &job.id,
                BufferedReply {
                    status: StatusCode::OK,
                    headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                    body: Bytes::from_static(br#"{"ok":true}"#),
                },
            )
            .await;
        assert_eq!(manager.get_for("other-app", &job.id).await, None);
        let stored = manager.get_for("batch-app", &job.id).await.unwrap();
        assert_eq!(stored.status, "succeeded");
        assert_eq!(stored.result.unwrap()["ok"], true);
        assert!(manager.consume_result("batch-app", &job.id).await.is_some());

        let reloaded = JobManager::new(path.clone()).await.unwrap();
        assert_eq!(reloaded.list_for("batch-app", 10).await.len(), 1);
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn v1_requests_are_served_by_rust_and_non_v1_falls_back_to_control_plane() {
        let upstream = Router::new().route(
            "/backend-api/codex/responses",
            post(|| async {
                Json(json!({
                    "id": "resp-upstream",
                    "object": "response",
                    "model": "gpt-5.3-codex",
                    "status": "completed",
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "native rust"}]}],
                    "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
                }))
            }),
        );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let control_plane = Router::new().fallback(|| async { (StatusCode::OK, "control-plane") });
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;

        let store_path = temporary_path("accounts");
        let jobs_path = temporary_path("edge-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.node_control_plane_url = control_plane_url;
        config.configured_api_keys = vec![("test".to_owned(), "edge-secret".to_owned())];
        config.request_body_limit = 1024 * 1024;
        config.upstream_timeout = Duration::from_secs(5);

        let edge_state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(edge_state)).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .json(&json!({"model": "gpt-5.3-codex", "input": "hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response_body: Value = response.json().await.unwrap();
        assert_eq!(response_body["id"], "resp-upstream");
        assert_eq!(
            response_body["output"][0]["content"][0]["text"],
            "native rust"
        );

        let compressed = zstd::stream::encode_all(
            Cursor::new(b"{\"model\":\"gpt-5.3-codex\",\"input\":\"compressed\"}"),
            1,
        )
        .unwrap();
        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .header("content-type", "application/json")
            .header("content-encoding", "zstd")
            .body(compressed)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = client
            .get(format!("{edge_url}/v1/does-not-fallback"))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("Unknown /v1 endpoint")
        );

        let response = client
            .get(format!("{edge_url}/admin/from-control-plane"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "control-plane");

        edge_task.abort();
        upstream_task.abort();
        control_plane_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }
}
