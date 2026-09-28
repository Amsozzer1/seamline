#!/usr/bin/env bash
# Build seamcore to WebAssembly twice: once for the browser, once for Node.
# Uses plain cargo + a pinned wasm-bindgen-cli (must match the crate's wasm-bindgen version).
set -euo pipefail
cd "$(dirname "$0")/../seamcore"
export CARGO_TARGET_DIR="$PWD/target"
cargo build --release --target wasm32-unknown-unknown
WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/seamcore.wasm"
wasm-bindgen "$WASM" --target web    --out-dir pkg-web
wasm-bindgen "$WASM" --target nodejs --out-dir pkg-node
ls -lh pkg-web/*.wasm
