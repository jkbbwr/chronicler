//! Write the RPC TypeScript bindings to `frontend/src/rpc.gen.ts`.
//!
//! cargo run --manifest-path backend/Cargo.toml --bin gen-bindings

fn main() -> std::io::Result<()> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(chronicler_backend::rpc::bindings::OUTPUT_PATH);
    std::fs::write(&path, chronicler_backend::rpc::bindings::typescript())?;
    println!("wrote {}", path.display());
    Ok(())
}
