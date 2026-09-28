//! Manuscript compilation.

use crate::app::App;
use crate::compile::{self, Build, ChapterSpec, CompileSettings};
use crate::fsx::RelPath;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct CompileParams {
    pub settings: CompileSettings,
    pub chapters: Vec<ChapterSpec>,
    /// Front Matter files, in order.
    pub front_matter: Option<Vec<String>>,
    /// Back Matter files, in order.
    pub back_matter: Option<Vec<String>>,
}

#[derive(Serialize, TS)]
pub struct CompileResult {
    /// Absolute path of the artifact, inside `.chronicler/build/`.
    pub output: String,
}

pub async fn run(app: Arc<App>, p: CompileParams) -> Result<CompileResult> {
    let build = app
        .blocking(move |app| {
            let read_all = |files: &[String]| -> Result<Vec<String>> {
                files
                    .iter()
                    .map(|f| app.read(&RelPath::parse(f)?))
                    .collect()
            };
            let front = read_all(p.front_matter.as_deref().unwrap_or_default())?;
            let back = read_all(p.back_matter.as_deref().unwrap_or_default())?;
            let chapters = p
                .chapters
                .iter()
                .map(|c| Ok((c.title.clone(), read_all(&c.scenes)?)))
                .collect::<Result<Vec<_>>>()?;
            compile::write_source(&app.root, &front, &chapters, &back, &p.settings)
        })
        .await?;
    let output = match build {
        Build::Done(path) => path,
        Build::NeedsPdf { typ, pdf } => {
            compile::render_pdf(&typ, &pdf, compile::TYPST_TIMEOUT).await?;
            pdf
        }
    };
    Ok(CompileResult {
        output: output.display().to_string(),
    })
}
