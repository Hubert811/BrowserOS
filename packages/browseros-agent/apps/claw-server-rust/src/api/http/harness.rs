//! Harness reporting surface: an out-of-process harness (hub) that drives the
//! browser through its OWN CDP connection can still feed this server's audit
//! trail — session lifecycle, tool dispatches, and tab-ownership windows — so
//! its sessions appear in the cockpit timeline with attributed recordings.
//!
//! The trust model matches the rest of the local API surface: the server binds
//! localhost only, and these routes append audit rows rather than executing
//! browser actions, so an untrusted local caller gains no browser control.
//! Rows are append-only; the audit projections (task summary, session list)
//! are refreshed exactly the way the MCP dispatch path refreshes them.

use super::{error, internal};
use crate::{
    AppState,
    clock::now_epoch_ms,
    db::audit_log::{RecordToolDispatchInput, bounded_args_json},
    error::{CanonicalError, RequestId},
    ids::{DispatchId, SessionId},
};
use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
};
use claw_api::models::{
    HarnessClaimTabResponse, HarnessDispatchResponse, HarnessReleaseTabResponse,
    HarnessSessionEndResponse, HarnessSessionStartResponse, RecordingStreamEntry,
    RecordingStreamList,
};
use serde::Deserialize;
use serde_json::Value;
use tracing::warn;
use ulid::Ulid;

const MAX_AGENT_FIELD_LEN: usize = 128;
const DEFAULT_STREAM_LIMIT: i64 = 200;
const MAX_STREAM_LIMIT: i64 = 1_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartSessionBody {
    /// Client-supplied stable session id (e.g. a hub conversation id). A fresh
    /// Ulid is minted when absent, letting lightweight callers stay id-agnostic.
    #[serde(default)]
    session_id: Option<String>,
    /// Stable harness identity, e.g. "hub". Free-form: the audit tables key
    /// sessions by id, not by a closed agent enum.
    #[serde(default = "default_agent_id")]
    agent_id: String,
    /// Cockpit-facing slug, e.g. "hub".
    #[serde(default = "default_slug")]
    slug: String,
    /// Human label, e.g. "hub-browser".
    #[serde(default = "default_agent_label")]
    agent_label: String,
    #[serde(default = "default_client_name")]
    client_name: String,
    #[serde(default)]
    client_version: String,
}

fn default_agent_id() -> String {
    "hub".to_string()
}
fn default_slug() -> String {
    "hub".to_string()
}
fn default_agent_label() -> String {
    "hub-browser".to_string()
}
fn default_client_name() -> String {
    "hub".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EndSessionBody {
    /// Free-form lifecycle kind, e.g. "normal" / "idle".
    #[serde(default = "default_end_kind")]
    kind: String,
    #[serde(default)]
    reason: Option<String>,
}

fn default_end_kind() -> String {
    "normal".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DispatchBody {
    tool_name: String,
    /// Optional page/tab attribution; the fields flow straight into the
    /// dispatch row so the cockpit timeline and replay attribution work.
    #[serde(default)]
    page_id: Option<i64>,
    #[serde(default)]
    tab_id: Option<i64>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    title: Option<String>,
    /// Tool arguments; bounded to the same audit width as the MCP path.
    #[serde(default)]
    args: Option<Value>,
    /// Short result summary, e.g. "ok" or "error: not_found".
    #[serde(default = "default_result_meta")]
    result_meta: String,
    #[serde(default)]
    duration_ms: Option<i64>,
    /// Epoch-ms start for long-running tools so timeline ordering matches
    /// execution order; defaults to write time.
    #[serde(default)]
    created_at: Option<i64>,
    /// Client-side dispatch id (Ulid-shaped); minted when absent.
    #[serde(default)]
    dispatch_id: Option<String>,
    #[serde(default)]
    parent_dispatch_id: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    agent_label: Option<String>,
}

fn default_result_meta() -> String {
    "ok".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimTabBody {
    tab_id: i64,
    #[serde(default)]
    target_id: Option<String>,
    /// Epoch-ms claim start; defaults to now.
    #[serde(default)]
    claimed_at: Option<i64>,
    #[serde(default)]
    agent_id: Option<String>,
}

pub(super) async fn start_session(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Json(body): Json<StartSessionBody>,
) -> Result<Json<HarnessSessionStartResponse>, CanonicalError> {
    let session_id = match body.session_id {
        Some(id) if is_ulidish(&id) => id,
        Some(_) => {
            return Err(error(
                &request_id,
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "sessionId must be a client-supplied Ulid-shaped identifier",
            ));
        }
        None => SessionId::new(Ulid::new().to_string()).into_inner(),
    };
    let agent_id = bounded_field(&body.agent_id);
    let slug = bounded_field(&body.slug);
    let agent_label = bounded_field(&body.agent_label);
    state
        .audit_log
        .record_session_start(
            &session_id,
            &agent_id,
            &slug,
            &agent_label,
            &bounded_field(&body.client_name),
            &bounded_field(&body.client_version),
        )
        .await
        .map_err(|source| internal(&request_id, source))?;
    Ok(Json(HarnessSessionStartResponse::new(session_id)))
}

pub(super) async fn end_session(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<EndSessionBody>,
) -> Result<Json<HarnessSessionEndResponse>, CanonicalError> {
    ensure_known_session(&state, &request_id, &session_id).await?;
    state
        .audit_log
        .record_session_end(
            &session_id,
            &bounded_field(&body.kind),
            body.reason.as_deref(),
        )
        .await
        .map_err(|source| internal(&request_id, source))?;
    // Close every open tab-ownership window so replay attribution and orphan
    // cleanup see the same end state the MCP teardown path produces.
    state
        .session_tabs
        .release_claims_for_session(&session_id)
        .await
        .map_err(|source| internal(&request_id, source))?;
    Ok(Json(HarnessSessionEndResponse::new(true)))
}

pub(super) async fn report_dispatch(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<DispatchBody>,
) -> Result<Json<HarnessDispatchResponse>, CanonicalError> {
    ensure_known_session(&state, &request_id, &session_id).await?;
    let tool_name = bounded_field(&body.tool_name);
    if tool_name.is_empty() {
        return Err(error(
            &request_id,
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "toolName must not be empty",
        ));
    }
    let input = RecordToolDispatchInput {
        agent_id: bounded_field(body.agent_id.as_deref().unwrap_or("hub")),
        slug: bounded_field(body.slug.as_deref().unwrap_or("hub")),
        agent_label: bounded_field(body.agent_label.as_deref().unwrap_or("hub-browser")),
        session_id: session_id.clone(),
        tool_name,
        page_id: body.page_id,
        tab_id: body.tab_id,
        target_id: body.target_id,
        url: body.url,
        title: body.title,
        args_json: bounded_args_json(body.args.as_ref().unwrap_or(&Value::Null)),
        result_meta: truncate(&body.result_meta, 512),
        duration_ms: body.duration_ms.unwrap_or(0).max(0),
        created_at: body.created_at.filter(|at| *at > 0),
        dispatch_id: match body.dispatch_id {
            Some(id) if is_ulidish(&id) => DispatchId::from(id),
            _ => DispatchId::new(),
        },
        parent_dispatch_id: body
            .parent_dispatch_id
            .filter(|id| is_ulidish(id))
            .map(DispatchId::from),
        // External harness rows carry no token accounting; version 0 marks
        // unmeasured rows in the estimator contract.
        tool_input_token_estimate: 0,
        tool_output_token_estimate: 0,
        token_estimator_version: 0,
    };
    let row_id = state
        .audit_log
        .record_tool_dispatch(input)
        .await
        .map_err(|source| internal(&request_id, source))?;
    // Tab-attributed rows get a server-side preview screenshot, exactly like
    // the MCP path's audit observer produces for native sessions: the same
    // SessionVisualService pipeline (claim-window candidate, viewport JPEG,
    // in-flight concurrency guards) and the same screenshots store + marker.
    // Fire-and-forget so the report response stays as cheap as before; rows
    // without a claimable tab capture nothing (select_candidate -> None).
    if body.tab_id.is_some() {
        let state = state.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move {
            persist_harness_screenshot(&state, &session_id, row_id).await;
        });
    }
    Ok(Json(HarnessDispatchResponse::new(row_id)))
}

/// Attaches a viewport screenshot to a harness dispatch row — the native
/// pipeline (visuals capture -> screenshots store -> mark_screenshot) re-run
/// for sessions that hold no live MCP `Session`. Failures are logged and
/// never fail the report; captures of unowned/closed tabs simply skip.
async fn persist_harness_screenshot(state: &AppState, session_id: &str, row_id: i64) {
    let bytes = match state.visuals.capture_by_session_id(session_id).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return,
        Err(error) => {
            warn!(error = %error, row_id, "harness screenshot capture failed");
            return;
        }
    };
    if let Err(error) = state.screenshots.write(session_id, row_id, &bytes).await {
        warn!(error = %error, row_id, "harness screenshot write failed");
        return;
    }
    if let Err(error) = state.audit_log.mark_screenshot(row_id).await {
        warn!(error = %error, row_id, "harness screenshot marker failed");
    }
}

pub(super) async fn claim_tab(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ClaimTabBody>,
) -> Result<Json<HarnessClaimTabResponse>, CanonicalError> {
    ensure_known_session(&state, &request_id, &session_id).await?;
    if body.tab_id <= 0 {
        return Err(error(
            &request_id,
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "tabId must be a positive Chrome tab id",
        ));
    }
    let agent_id = bounded_field(body.agent_id.as_deref().unwrap_or("hub"));
    let claimed_at = body
        .claimed_at
        .filter(|at| *at > 0)
        .unwrap_or_else(now_epoch_ms);
    state.session_tabs.enqueue_claim_tab_for_session(
        body.tab_id,
        body.target_id,
        session_id,
        agent_id,
        claimed_at,
    );
    // The enqueue path is the production writer; drain turns this request
    // into a synchronous confirmation for the caller.
    state.session_tabs.drain_writes().await;
    Ok(Json(HarnessClaimTabResponse::new(true)))
}

pub(super) async fn release_tab(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Path((session_id, tab_id)): Path<(String, i64)>,
) -> Result<Json<HarnessReleaseTabResponse>, CanonicalError> {
    ensure_known_session(&state, &request_id, &session_id).await?;
    if tab_id <= 0 {
        return Err(error(
            &request_id,
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "tabId must be a positive Chrome tab id",
        ));
    }
    state
        .session_tabs
        .enqueue_release_tab_for_session(tab_id, session_id);
    state.session_tabs.drain_writes().await;
    Ok(Json(HarnessReleaseTabResponse::new(true)))
}

async fn ensure_known_session(
    state: &AppState,
    request_id: &RequestId,
    session_id: &str,
) -> Result<(), CanonicalError> {
    let known = state
        .audit_log
        .get_task_summary(session_id)
        .await
        .map_err(|source| internal(request_id, source))?
        .is_some();
    if known {
        return Ok(());
    }
    Err(error(
        request_id,
        StatusCode::NOT_FOUND,
        "not_found",
        "unknown session; start it with POST /api/v1/harness/sessions first",
    ))
}

fn is_ulidish(value: &str) -> bool {
    let len = value.len();
    (26..=64).contains(&len) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn bounded_field(value: &str) -> String {
    truncate(value.trim(), MAX_AGENT_FIELD_LEN)
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut cut = max;
    while cut > 0 && !value.is_char_boundary(cut) {
        cut -= 1;
    }
    value[..cut].to_string()
}

/// Lists recorded streams for discovery: the out-of-process harness cannot
/// know which Chrome tabs captured rrweb data, so it starts from this index.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct StreamListQuery {
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    #[serde(default)]
    tab_id: Option<i64>,
    limit: Option<i64>,
}

pub(super) async fn list_streams(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Query(query): Query<StreamListQuery>,
) -> Result<Json<RecordingStreamList>, CanonicalError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_STREAM_LIMIT)
        .clamp(1, MAX_STREAM_LIMIT);
    let rows = state
        .recordings
        .list_streams(query.from_ms, query.to_ms, query.tab_id, limit)
        .await
        .map_err(|source| internal(&request_id, source))?;
    let streams = rows
        .into_iter()
        .map(|row| {
            let mut entry = RecordingStreamEntry::new(
                row.document_id,
                row.tab_id,
                row.first_event_at,
                row.last_event_at,
                row.size_bytes,
                row.event_count,
                row.has_gap,
            );
            entry.target_id = row.target_id;
            entry
        })
        .collect();
    Ok(Json(RecordingStreamList::new(streams)))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct StreamEventsQuery {
    from_ms: Option<i64>,
    to_ms: Option<i64>,
}

pub(super) async fn stream_events(
    Extension(request_id): Extension<RequestId>,
    State(state): State<AppState>,
    Path(document_id): Path<String>,
    Query(query): Query<StreamEventsQuery>,
) -> Result<Response, CanonicalError> {
    if document_id.is_empty() || document_id.len() > 128 {
        return Err(error(
            &request_id,
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "documentId must be a non-empty recording document id",
        ));
    }
    let from = query.from_ms.filter(|at| *at > 0).unwrap_or(i64::MIN);
    let to = query.to_ms.filter(|at| *at > 0).unwrap_or(i64::MAX);
    let events = state
        .recordings
        .read_range(&document_id, from, to)
        .await
        .map_err(|source| internal(&request_id, source))?;
    let mut ndjson = String::new();
    for event in events {
        ndjson.push_str(
            &serde_json::to_string(&event)
                .map_err(|source| internal(&request_id, source.into()))?,
        );
        ndjson.push('\n');
    }
    let mut response = Response::new(Body::from(ndjson));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/x-ndjson"),
    );
    Ok(response)
}
