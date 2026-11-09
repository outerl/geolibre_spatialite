#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Copyright (c) 2026 Outer Loop Consulting

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${ROOT_DIR}/src/wasm"

mkdir -p "${OUTPUT_DIR}"

echo "=========================================================="
echo " Building True Upstream C SpatiaLite for WebAssembly"
echo "=========================================================="

if command -v docker &> /dev/null && docker info &> /dev/null; then
    echo "Using Docker builder..."
    IMAGE_TAG="geolibre-spatialite-wasm-builder"
    
    docker build -t "${IMAGE_TAG}" -f "${SCRIPT_DIR}/Dockerfile" "${ROOT_DIR}"
    
    CONTAINER_ID=$(docker create "${IMAGE_TAG}")
    docker cp "${CONTAINER_ID}:/dist/spatialite.js" "${OUTPUT_DIR}/spatialite.js"
    docker cp "${CONTAINER_ID}:/dist/spatialite.wasm" "${OUTPUT_DIR}/spatialite.wasm"
    docker rm "${CONTAINER_ID}"
    
    echo "Build succeeded! Artifacts written to: ${OUTPUT_DIR}"
    ls -lh "${OUTPUT_DIR}"
    exit 0
fi

echo "Docker not running or unavailable. Checking for local Emscripten SDK (emcc)..."
if ! command -v emcc &> /dev/null; then
    echo "Error: Neither Docker nor Emscripten (emcc) is available."
    echo "Please start Docker Desktop or install the Emscripten SDK (emsdk)."
    echo "Alternatively, trigger the automated GitHub Actions workflow: .github/workflows/build-wasm.yml"
    exit 1
fi

echo "Emscripten detected: $(emcc --version | head -n 1)"
echo "Please run via Docker or GitHub Actions for deterministic reproducible compilation."
