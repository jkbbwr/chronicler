//! Typed JSON-RPC dispatch.
//!
//! Every method is one line in the [`methods!`] table: its wire name, whether
//! the handler is synchronous (run on the blocking pool) or async, the
//! handler, and its params/result types. The same table drives dispatch and
//! the generated TypeScript bindings (`frontend/src/rpc.gen.ts`).

pub mod bindings;
pub mod protocol;

mod agents;
mod codex;
mod compile;
mod diag;
mod docs;
mod history;
mod story;
mod journal;
mod research;
mod system;
mod tts;

use crate::app::App;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use ts_rs::TS;

pub const PARSE_ERROR: i32 = -32700;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;
pub const SERVER_ERROR: i32 = -32000;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
        }
    }

    pub fn from_panic(payload: Box<dyn std::any::Any + Send>) -> Self {
        let msg = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        tracing::error!("handler panicked: {msg}");
        RpcError::new(INTERNAL_ERROR, format!("Internal error: {msg}"))
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(e: anyhow::Error) -> Self {
        let code = if e.chain().any(|c| c.is::<InvalidParams>()) {
            INVALID_PARAMS
        } else {
            SERVER_ERROR
        };
        RpcError::new(code, format!("{e:#}"))
    }
}

/// A client mistake (bad path, empty required field): answered with -32602.
#[derive(Debug)]
pub struct InvalidParams(pub String);

impl std::fmt::Display for InvalidParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidParams {}

pub fn invalid(msg: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(InvalidParams(msg.into()))
}

/// A required string that must not be blank.
pub fn required<'a>(field: &str, value: &'a str) -> anyhow::Result<&'a str> {
    if value.trim().is_empty() {
        Err(invalid(format!("Missing param: {field}")))
    } else {
        Ok(value)
    }
}

/// Params for methods that take none (`{}` or `null` on the wire).
#[derive(Deserialize, TS, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}

fn parse_params<P: DeserializeOwned>(params: Value) -> Result<P, RpcError> {
    let params = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params
    };
    serde_json::from_value(params)
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("Invalid params: {e}")))
}

fn to_result<R: Serialize>(r: R) -> Result<Value, RpcError> {
    serde_json::to_value(r).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
}

/// Run a synchronous handler on the blocking pool; a panic becomes an error.
async fn run_blocking<T: Send + 'static>(
    app: Arc<App>,
    f: impl FnOnce(&App) -> anyhow::Result<T> + Send + 'static,
) -> Result<T, RpcError> {
    match tokio::task::spawn_blocking(move || f(&app)).await {
        Ok(r) => r.map_err(RpcError::from),
        Err(e) if e.is_panic() => Err(RpcError::from_panic(e.into_panic())),
        Err(e) => Err(RpcError::new(INTERNAL_ERROR, e.to_string())),
    }
}

macro_rules! methods {
    ($( $name:literal => $mode:ident $handler:path : ($P:ty) -> $R:ty ; )*) => {
        /// Dispatch one request. Unknown methods, bad params, handler errors
        /// and blocking-pool panics all come back as `RpcError`.
        pub async fn dispatch(app: Arc<App>, method: &str, params: Value) -> Result<Value, RpcError> {
            match method {
                $( $name => {
                    let p: $P = parse_params(params)?;
                    let r: $R = methods!(@run $mode, app, p, $handler);
                    to_result(r)
                } )*
                _ => Err(RpcError::new(METHOD_NOT_FOUND, format!("Method not found: {method}"))),
            }
        }

        /// Every method name, for tests and diagnostics.
        pub const METHODS: &[&str] = &[$($name),*];

        pub(crate) fn describe(b: &mut bindings::Builder) {
            $( b.method::<$P, $R>($name); )*
        }
    };
    (@run sync, $app:ident, $p:ident, $handler:path) => {
        run_blocking($app, move |app| $handler(app, $p)).await?
    };
    (@run async, $app:ident, $p:ident, $handler:path) => {
        $handler($app, $p).await.map_err(RpcError::from)?
    };
}

methods! {
    // ---- system & settings ----
    "ping" => sync system::ping: (NoParams) -> String;
    "system/info" => sync system::info: (NoParams) -> system::SystemInfo;
    "system/tools" => sync system::tools: (NoParams) -> system::Tools;
    "system/tools_set" => sync system::tools_set: (system::ToolPathParams) -> system::Tools;
    "db/get" => sync system::setting_get: (system::SettingGetParams) -> system::SettingValue;
    "db/set" => sync system::setting_set: (system::SettingSetParams) -> ();
    "stats/get" => sync system::stats: (system::StatsParams) -> crate::stats::ProjectStats;

    // ---- documents & the binder ----
    "document/read" => sync docs::read: (docs::PathParams) -> docs::DocumentContent;
    "document/save" => sync docs::save: (docs::SaveParams) -> ();
    "project/list_files" => sync docs::list_files: (NoParams) -> docs::FileList;
    "project/create_folder" => sync docs::create_folder: (docs::PathParams) -> ();
    "project/rename" => sync docs::rename: (docs::RenameParams) -> ();
    "project/delete" => sync docs::delete: (docs::PathParams) -> ();
    "project/search" => sync docs::search: (docs::SearchParams) -> docs::SearchResults;
    "project/replace" => sync docs::replace: (docs::ReplaceParams) -> docs::ReplaceResult;
    "meta/get_all" => sync docs::meta_all: (NoParams) -> docs::SceneMetaList;
    "meta/set" => sync docs::meta_set: (docs::MetaSetParams) -> ();

    // ---- story structure ----
    "threads/list" => sync story::threads: (NoParams) -> story::ThreadList;
    "threads/create" => sync story::thread_create: (story::ThreadCreateParams) -> codex::IdResult;
    "threads/update" => sync story::thread_update: (story::ThreadUpdateParams) -> ();
    "threads/delete" => sync story::thread_delete: (codex::IdParams) -> ();
    "story/reader_knowledge" => sync story::reader_knowledge: (docs::PathParams) -> crate::story::ReaderKnowledge;
    "notes/list" => sync story::notes: (NoParams) -> story::NoteList;
    "notes/resolve" => sync story::note_resolve: (story::NoteResolveParams) -> ();
    "scene/split" => sync story::split: (story::SplitParams) -> story::SplitResult;
    "scene/merge" => sync story::merge: (docs::PathParams) -> story::MergeResult;

    // ---- hot-exit journal ----
    "journal/write" => sync journal::write: (journal::JournalWriteParams) -> ();
    "journal/read" => sync journal::read: (NoParams) -> journal::JournalEntries;
    "journal/clear" => sync journal::clear: (journal::JournalClearParams) -> ();

    // ---- codex ----
    "codex/list" => sync codex::list: (NoParams) -> codex::EntityList;
    "codex/create" => sync codex::create: (codex::EntityCreateParams) -> codex::IdResult;
    "codex/update" => sync codex::update: (codex::EntityUpdateParams) -> ();
    "codex/delete" => sync codex::delete: (codex::IdParams) -> ();
    "codex/add_alias" => sync codex::add_alias: (codex::AddAliasParams) -> ();
    "codex/mentions" => sync codex::mentions: (codex::IdParams) -> codex::MentionList;
    "codex/candidates" => sync codex::candidates: (NoParams) -> codex::CandidateList;
    "codex/dismiss" => sync codex::dismiss: (codex::NameParams) -> ();
    "codex/promote" => sync codex::promote: (codex::PromoteParams) -> crate::codex::Promoted;
    "codex/suggest" => sync codex::suggest: (codex::CodexSuggestParams) -> codex::CodexSuggestResult;
    "codex/reindex" => sync codex::reindex: (NoParams) -> codex::ReindexResult;
    "codex/scan" => sync codex::scan: (codex::OptionalPathParams) -> codex::ScanResult;
    "codex/graph" => sync codex::graph: (NoParams) -> crate::codex::Graph;
    "codex/rename_preview" => sync codex::rename_preview: (codex::RenamePreviewParams) -> crate::rename::RenamePreview;
    "codex/rename_apply" => sync codex::rename_apply: (codex::RenameApplyParams) -> crate::rename::RenameResult;
    "index/rebuild" => sync codex::rebuild: (NoParams) -> codex::RebuildResult;
    "relations/add" => sync codex::relation_add: (codex::RelationAddParams) -> codex::IdResult;
    "relations/delete" => sync codex::relation_delete: (codex::IdParams) -> ();

    // ---- prose diagnostics & NER ----
    "diag/status" => sync diag::status: (NoParams) -> diag::DiagStatus;
    "diag/check" => sync diag::check: (codex::OptionalPathParams) -> diag::DiagFiles;
    "diag/fix" => sync diag::fix: (diag::FixParams) -> ();
    "diag/suggest" => sync diag::suggest: (diag::SpellSuggestParams) -> diag::Suggestions;
    "diag/add_word" => sync diag::add_word: (diag::WordParams) -> ();
    "diag/ignore" => sync diag::ignore: (diag::IgnoreParams) -> ();
    "diag/dictionary" => sync diag::dictionary: (NoParams) -> diag::WordList;
    "diag/remove_word" => sync diag::remove_word: (diag::WordParams) -> ();
    "diag/ignored" => sync diag::ignored: (NoParams) -> diag::IgnoredList;
    "diag/unignore" => sync diag::unignore: (diag::Ignored) -> ();
    "diag/get_dialect" => sync diag::get_dialect: (NoParams) -> diag::DialectValue;
    "diag/set_dialect" => sync diag::set_dialect: (diag::DialectValue) -> ();
    "diag/style_get" => sync diag::style_get: (NoParams) -> crate::diagnostics::StyleChecks;
    "diag/style_set" => sync diag::style_set: (diag::StyleChecksPatch) -> crate::diagnostics::StyleChecks;
    "diag/prose_report" => sync diag::prose_report: (NoParams) -> crate::diagnostics::ProseReport;
    "ner/status" => sync diag::ner_status: (NoParams) -> diag::NerStatus;
    "ner/ensure" => async diag::ner_ensure: (NoParams) -> diag::Ready;

    // ---- AI configuration ----
    "ai/config" => sync agents::ai_config: (NoParams) -> agents::AiConfigView;
    "ai/config_set" => sync agents::ai_config_set: (agents::AiConfigSetParams) -> ();
    "ai/set_key" => sync agents::ai_set_key: (agents::KeyParams) -> ();
    "ai/models" => async agents::ai_models: (NoParams) -> agents::ModelList;
    "ai/test" => async agents::ai_test: (NoParams) -> agents::TestResult;
    "ai/default_prompts" => sync agents::default_prompts: (NoParams) -> agents::DefaultPrompts;
    "ai/scan" => async agents::ai_scan: (docs::PathParams) -> agents::AiScanResult;

    // ---- read aloud ----
    "tts/config" => sync tts::config: (NoParams) -> tts::TtsConfigView;
    "tts/config_set" => sync tts::config_set: (tts::TtsConfigSetParams) -> ();
    "tts/models" => async tts::models: (NoParams) -> tts::SpeechModelList;
    "tts/voices" => async tts::voices: (NoParams) -> tts::TtsVoiceList;
    "tts/speak" => async tts::speak: (tts::SpeakParams) -> tts::SpeakResult;

    // ---- agents ----
    "agents/chat" => async agents::chat: (agents::ChatParams) -> agents::ChatResult;
    "agents/stop" => sync agents::stop: (agents::StopParams) -> agents::Stopped;
    "agents/continuity" => async agents::continuity: (codex::OptionalPathParams) -> agents::ContinuityResult;
    "agents/finding_dismiss" => sync agents::finding_dismiss: (codex::IdParams) -> ();
    "agents/ledger" => async agents::ledger: (agents::LedgerParams) -> agents::LedgerResult;
    "agents/facts" => sync agents::facts: (agents::FactsParams) -> agents::Markdown;
    "agents/timeline_build" => async agents::timeline_build: (NoParams) -> crate::agents::StoredTimeline;
    "agents/timeline" => sync agents::timeline: (NoParams) -> Option<crate::agents::StoredTimeline>;
    "agents/relations_build" => async agents::relations_build: (NoParams) -> agents::LinksResult;
    "agents/synopses" => async agents::synopses: (NoParams) -> agents::DraftedResult;
    "agents/hygiene" => async agents::hygiene: (NoParams) -> agents::HygieneResult;
    "agents/voice" => async agents::voice: (codex::IdParams) -> agents::Markdown;
    "agents/critique" => async agents::critique: (agents::CritiqueParams) -> agents::CritiqueResult;
    "agents/fill" => async agents::fill: (agents::FillParams) -> agents::TextResult;
    "agents/index" => async agents::index: (NoParams) -> agents::IndexResult;
    "agents/status" => sync agents::status: (NoParams) -> agents::IndexStatus;
    "agents/estimate" => async agents::estimate: (agents::EstimateParams) -> crate::agents::Estimate;
    "agents/catch_up" => async agents::catch_up: (agents::CatchUpParams) -> crate::catchup::CatchUp;

    // ---- compile ----
    "compile/run" => async compile::run: (compile::CompileParams) -> compile::CompileResult;

    // ---- research ----
    "research/list" => sync research::list: (NoParams) -> research::ResearchList;
    "research/new_note" => sync research::new_note: (research::ResearchNoteParams) -> research::ResearchPath;
    "research/clip" => async research::clip: (research::ResearchClipParams) -> research::ResearchClipResult;
    "research/read" => sync research::read: (docs::PathParams) -> research::ResearchText;

    // ---- history ----
    "history/changes" => sync history::changes: (codex::OptionalPathParams) -> crate::history::ChangeList;
    "history/evolog" => sync history::evolog: (history::ChangeIdParams) -> crate::history::Evolog;
    "history/describe" => sync history::describe: (history::DescribeParams) -> ();
    "history/lock_in" => sync history::lock_in: (history::LockInParams) -> crate::history::LockIn;
    "history/restore" => sync history::restore: (history::RestoreParams) -> ();
    "history/diff" => sync history::diff: (history::DiffParams) -> crate::history::Diff;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bad_params_are_invalid_params() {
        let dir = std::env::temp_dir().join(format!("chronicler-rpc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (app, _q) = App::open(&dir, crate::app::Output::discard()).unwrap();
        let e = dispatch(
            app.clone(),
            "document/read",
            serde_json::json!({ "rel_path": "a.md" }),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, INVALID_PARAMS);
        let e = dispatch(
            app.clone(),
            "codex/delete",
            serde_json::json!({ "id": "x" }),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, INVALID_PARAMS);
        let e = dispatch(
            app.clone(),
            "project/delete",
            serde_json::json!({ "path": "." }),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, INVALID_PARAMS);
        let e = dispatch(app.clone(), "nope", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(e.code, METHOD_NOT_FOUND);
        assert_eq!(dispatch(app, "ping", Value::Null).await.unwrap(), "pong");
        std::fs::remove_dir_all(&dir).ok();
    }
}
