//! Chronicler backend: a JSON-RPC-over-stdio server for one project folder
//! (the process's working directory).

pub mod agents;
pub mod ai;
pub mod app;
pub mod book;
pub mod catchup;
pub mod codex;
pub mod compile;
pub mod db;
pub mod diagnostics;
pub mod embed;
pub mod events;
pub mod fsx;
pub mod history;
pub mod indexer;
pub mod journal;
pub mod ner;
pub mod rename;
pub mod research;
pub mod rpc;
pub mod server;
pub mod stats;
pub mod story;
pub mod tools;
pub mod tts;

pub use app::App;
