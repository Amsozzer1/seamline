# 1. Rust core -> WebAssembly (browser + Node builds)
FROM rust:1.90-slim AS wasm
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.100 --locked
WORKDIR /app
COPY seamcore/Cargo.toml seamcore/Cargo.lock seamcore/
COPY seamcore/src seamcore/src
COPY scripts/build-wasm.sh scripts/
RUN scripts/build-wasm.sh

# 2. Frontend and server builds
FROM node:22-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY --from=wasm /app/seamcore/pkg-web seamcore/pkg-web
COPY --from=wasm /app/seamcore/pkg-node seamcore/pkg-node
COPY server server
COPY web web
RUN cd web && npm run build \
 && cd ../server && npm run build && npm prune --omit=dev

# 3. Runtime: one Node process serving the API, the event stream and the built frontend
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=wasm /app/seamcore/pkg-node seamcore/pkg-node
COPY db db
COPY samples samples
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
