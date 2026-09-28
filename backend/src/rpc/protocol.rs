use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An incoming JSON-RPC request. `jsonrpc` is not enforced; a missing id is
/// answered with a null id.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
}

#[derive(Debug, Serialize)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
}

impl Response {
    pub fn success(id: Value, result: Value) -> Self {
        Response {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, err: super::RpcError) -> Self {
        Response {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(ErrorObject {
                code: err.code,
                message: err.message,
            }),
        }
    }
}
