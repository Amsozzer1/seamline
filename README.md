# Seamline

Seamline turns a stiffened steel panel into a reviewable weld plan. It finds every weld
seam, puts the seams in a build order, lets an engineer review and release the plan in
3D, and shows an operator a simulated weld cell working through it, including a fault
and a recovery.

**Live demo:** LIVE_URL (free tier, so the first load after a quiet period can take a few seconds)

![Seamline demo](docs/demo.gif)

```
panel spec -> seams -> weld sequence -> review and reorder in 3D -> release -> run on the cell -> fault -> retry -> complete
```

## How it fits together

```
                 browser                                         server (one Node process)
 ┌─────────────────────────────────────┐          ┌──────────────────────────────────────────┐
 │ React + React Three Fiber           │  REST    │ Express API                              │
 │   plan editor, operator screen      │ ───────► │   revisions: draft -> released (409s)    │
 │                                     │          │   seamcore (WASM) re-checks every plan   │
 │ seamcore (Rust -> WASM)             │   SSE    │                                          │
 │   live validation + seam extraction │ ◄─────── │ simulated weld cell                      │
 └─────────────────────────────────────┘          │   walks a released plan, emits events    │
                                                  └──────────────────┬───────────────────────┘
                                                                     │
                                                          PostgreSQL │ panels, revisions,
                                                                     │ runs, run_events (log)
```

- **`seamcore/`** (Rust): spec validation, seam extraction, the default sequencer, and the
  plan checker. Compiled to WebAssembly twice, once for the browser and once for Node, so
  both sides share one definition of a panel's seams.
- **`server/`** (Express, TypeScript): revisions and their state machine, runs, the
  simulated cell, and the event stream. Also serves the built frontend.
- **`web/`** (React, React Three Fiber): the panel list, the plan editor with a 3D view,
  and the operator screen.

## Decisions and trade-offs

The full log, including problems hit along the way, is in
[docs/decisions.md](docs/decisions.md). The main ones:

**Seams come from a parametric spec, not from CAD.** Reading STEP geometry properly needs
a geometry kernel and more than the one day this was built in. A small JSON spec (a plate
and flat-bar stiffeners) keeps the geometry exact, so the time went into sequencing,
review and execution rather than into faking CAD import on top of a mesh.

**Crossings are modelled the way the parts are built.** Longitudinals run continuously;
transverses are cut into intercostal pieces between them. At each crossing the transverse
fillets split around the longitudinal web, and each piece end gets two joint welds, one
per face. My first draft had two joint welds per crossing instead of four; drawing the
parts out caught it before the tests did. T-junctions have no seam rule here, so they are
rejected rather than guessed.

**The sequencer is a set of rules you can explain, not an optimiser.** Tack everything,
then weld from the centre outward, alternating the two faces of each stiffener to balance
heat. Stated that simply, the rule failed on the most important seams: a full-length
stiffener passes through the centre, so neither end is "further out". Those seams are now
welded as two halves that both start at the centre. The rules stand in for distortion
modelling and are not a substitute for it.

**One Rust core, two runtimes.** The browser runs it on every keystroke of the spec editor
for instant validation; the server runs the same build to re-check every saved plan. The
original wasm-pack project had moved, so the build uses cargo plus a pinned
wasm-bindgen CLI, which also turned out to be more reliable in Docker.

**State transitions are enforced in SQL.** Every change is a conditional update (`where
status = 'draft'`), and partial unique indexes allow one draft per panel and one open run
per revision. Stale or duplicate requests get a 409 instead of racing.

**The event log is the source of truth for a run.** The cell writes each event to Postgres
before publishing it, and the operator screen rebuilds its state from that log over
server-sent events, resuming from the last event it saw after a reconnect. Retry is a
single conditional update, so two operators clicking at once cannot start the cell twice.
A server restart shows up as a fault the operator can retry, the same as a controller
losing power.

**Built for a public link.** There is no login, so sample panels are locked (duplicate one
to edit it), active runs are capped, and anyone can reset the demo data. Hosting is a
free Render instance with Neon Postgres, kept warm by a timer on a home server that pings
an endpoint which deliberately never touches the database, so Neon can still sleep.

## Limits

- Parametric flat-bar panels only: no CAD import, no tees, bulb flats or cutouts.
- Sequencing is heuristic; there is no distortion, heat input or reachability model.
- The weld cell is simulated. There is no robot motion, weld parameters or controller
  interface.
- No authentication; this is a public demo.

## What I would do next

- STEP/B-rep import through OpenCascade: find contact faces between parts, turn their
  shared edges into seams, and feed the same sequencer and checker.
- Distortion-aware sequencing, and fixtures and clamping in the model.
- Robot reachability and torch-access checks per seam.
- Move the cell into its own process that buffers events while offline and replays them
  in order, and put a real controller driver behind the same interface.
- Revision diffs and an audit view over the existing event log.

## Running locally

Requires Rust (with `wasm32-unknown-unknown`), `wasm-bindgen-cli` 0.2.100, Node 22 and
PostgreSQL.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked
createdb seamline

scripts/build-wasm.sh
npm ci --prefix server && npm ci --prefix web
npm run dev:server        # API on :3001, migrates and seeds on start
npm run dev:web           # http://localhost:5173
```

Tests:

```sh
npm test                  # Rust: seam counts, crossings, validation, sequencing, plan checks
npm run smoke             # against a running server: 409s, the scripted fault,
                          # concurrent retries, and SSE replay order
```

Or run everything in one container: `docker build -t seamline . && docker run -p 3001:3001 -e DATABASE_URL=... seamline`.

## License

MIT
