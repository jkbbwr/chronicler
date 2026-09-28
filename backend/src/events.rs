//! Backend → frontend notifications. Sent as JSON-RPC notifications:
//! `{"jsonrpc":"2.0","method":…,"params":…}`.

use crate::diagnostics::Diagnostic;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Serialize, TS, Debug, Clone)]
#[serde(tag = "method", content = "params")]
#[ts(rename = "RpcEvent")]
pub enum Event {
    /// Files or folders changed on disk (saves, external editors, sync tools).
    #[serde(rename = "project/changed")]
    ProjectChanged { paths: Vec<String> },
    /// The working draft's history moved (a save was captured).
    #[serde(rename = "history/changed")]
    HistoryChanged {},
    /// Fresh diagnostics for files that just changed.
    #[serde(rename = "diag/updated")]
    DiagUpdated {
        files: BTreeMap<String, Vec<Diagnostic>>,
    },
    /// The language engine finished loading; checks are now fast.
    #[serde(rename = "diag/ready")]
    DiagReady {},
    /// Discovery surfaced new codex candidates.
    #[serde(rename = "codex/changed")]
    #[serde(rename_all = "camelCase")]
    CodexChanged { new_candidates: usize },
    /// Streaming text from an agent chat run.
    #[serde(rename = "agents/delta")]
    AgentDelta { id: String, text: String },
    /// An agent chat run called a tool.
    #[serde(rename = "agents/tool")]
    AgentTool {
        id: String,
        name: String,
        args: Value,
    },
    /// An agent chat run's tool call finished.
    #[serde(rename = "agents/tool_done")]
    AgentToolDone { id: String, name: String },
    /// An agent run failed mid-stream.
    #[serde(rename = "agents/error")]
    AgentError { id: String, message: String },
    /// Progress note from a long agent job (`job` is its run id).
    #[serde(rename = "agents/sweep")]
    AgentSweep { job: String, note: String },
    /// An agent recorded a finding against a scene.
    #[serde(rename = "agents/finding")]
    AgentFinding { file: String },
    /// Dev only, sent by the Electron main process: the backend is being
    /// rebuilt and restarted.
    #[serde(rename = "system/recompiling")]
    SystemRecompiling {},
}

impl Event {
    pub fn to_line(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut v {
            map.insert("jsonrpc".into(), Value::from("2.0"));
        }
        v.to_string()
    }
}
