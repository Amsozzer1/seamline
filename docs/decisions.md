# Decisions log

Written as the project was built, in the order things came up. Each entry is what was
decided, what was rejected, and why. Problems hit along the way are included, because
most of the interesting decisions came from them.

## Scope

**Seams come from a parametric panel spec, not from CAD import.** A real pipeline would
read STEP/B-rep geometry and find seams from face adjacency. Doing that honestly needs a
geometry kernel (OpenCascade) and more than a day. A small JSON spec (plate plus flat-bar
stiffeners) keeps the geometry exact, so the interesting parts, sequencing, review and
execution, can be built properly instead of faked on top of a mesh.

**Axis-aligned flat bars only.** Every stiffener runs along x or y. This covers the
micropanel shape (a plate with longitudinals and intercostal transverses) and keeps
crossing logic exact. Tees, angles, bulb flats and cutouts are the next profiles to add.

**Built in one day, cut deliberately.** Cut: job queue, revision diff view, audit log UI,
STEP import, a separate cell process with offline buffering. The run event log in
Postgres already gives most of an audit trail.

## Geometry

**Longitudinals are continuous; transverses are intercostal.** Where they cross, the
transverse is cut into pieces that fit between the longitudinals. Its plate fillets are
split around each longitudinal web, and each piece end is welded to the longitudinal on
both faces.

**Problem: the first seam model had the wrong joint count.** The plan said two joint
welds per crossing. Drawing it out showed four: two piece ends (one each side of the
longitudinal), each welded on both faces of the transverse web. The tests were written
against the corrected count (the grid sample has 18 seams, not 14).

**T-junctions are rejected, not guessed.** A stiffener that ends on another one, or a
crossing that lands on a stiffener's end, has no seam rule in this model. Validation
reports `junction_unsupported` rather than producing plausible but wrong seams.

**Validation errors are specific and block planning; warnings do not.** Out of bounds,
zero length, overlap, bad dimensions and duplicate ids are errors. Stiffeners closer
than 250 mm (torch clearance) is a warning. Size limits (40 stiffeners, 30 m plate) keep
a hostile spec from stalling the server, because planning runs synchronously.

## Sequencing

**Explainable heuristics, not an optimiser.** Tack every seam first, then weld from the
centre of the panel outward, alternating the two faces of each piece to balance heat,
nearest-next within 100 mm distance bands. These stand in for distortion modelling and
are labelled as such.

**Problem: "centre outward" did not work for the seams that matter most.** A full-length
longitudinal passes through the centre, so both of its ends are equally far from it and
the rule could not choose a direction; it would have been welded end to end. Fillets
longer than 2 m that span the centre are now welded as two halves, each starting at the
centre, both faces of a stiffener alternating. The plan checker accepts either one full
weld or both halves per seam.

**Reordering happens within a phase.** The step list lets you drag tacks among tacks and
welds among welds, which keeps "every tack before any weld" true by construction. The
Rust check still validates every saved plan, since the API can be called directly.

## One core, two runtimes

**The Rust crate runs in the browser and on the server.** The browser uses it for live
validation and seam extraction while the spec is edited; the server uses the same build
to re-check every plan it saves and to time the simulated cell. There is one definition
of what a panel's seams are.

**Problem: wasm-pack's home moved.** The original GitHub organisation behind wasm-pack
was archived, so the build uses plain `cargo build --target wasm32-unknown-unknown` plus
a pinned `wasm-bindgen-cli` (it must match the crate's `wasm-bindgen` version exactly).
This also avoids wasm-pack downloading `wasm-opt` at build time, which is unreliable
inside Docker on ARM.

**Plain JSON strings across the WASM boundary.** Slightly slower than passing structured
values, but the payloads are small and it makes the browser and Node bindings identical.

**A panic in WASM must never happen on user input.** A Rust panic inside the Node WASM
instance could leave the shared module unusable. All input paths return errors instead,
and a test feeds garbage to both entry points.

## Backend

**Express and Postgres, with state machines enforced in SQL.** Every transition is a
conditional update (`... where status = 'draft'`), so a stale request gets a 409 rather
than a race. Partial unique indexes enforce one draft per panel and one open run per
revision at the database level.

**Problem: `jsonb` reordered the spec's keys.** Postgres `jsonb` normalises key order, so
the spec editor showed `end` before `start`. The spec column is `json`, which keeps the
text as written. Steps stay `jsonb`.

**TypeScript pinned to 5.9.** A fresh install pulled TypeScript 7 (the native compiler).
On a one-day timeline that was not the risk to take.

## The simulated cell

**The cell runs inside the API process.** A separate process with its own buffering is
closer to a real edge device, and it is the next step. In-process keeps the demo to one
deploy while keeping the same shape: the cell only talks to the database and an event bus.

**The event log is the source of truth.** Every event is written to `run_events` before it
is published. The browser gets events over server-sent events and replays from
`Last-Event-ID` on reconnect. The stream subscribes before it queries history and
de-duplicates by id, so an event written between the two is never lost.

**Resuming is a conditional update, not in-memory state.** A fault ends the cell's loop.
Retry or Skip flips the run row from `faulted` to `running` in one statement and starts
a fresh loop from `current_step`. When two operators click Retry at the same time,
exactly one update succeeds; the smoke test checks this.

**Problem: event ids were strings on the live path only.** Postgres returns `bigint` as a
string. Replayed events were converted to numbers, but live ones were not, and the
browser de-duplicates by comparing ids; as strings, `"100" <= "99"` is true, so every run
would have started silently dropping events once ids reached three digits. It was caught
by holding a live stream open against the deployed app, not by the tests, which only
checked replay. `bigint` is now parsed as a number at the driver, and the smoke test
captures the live stream too and asserts integer ids (it fails without the fix).

**A server restart is just another fault.** On boot, any run still marked `running` is
set to `faulted` with "controller lost power mid-step". The operator retries the
interrupted step, the same way they would on a real cell.

**One scripted fault per run, recorded in the event log.** The third weld always faults
once, so the demo is repeatable. Whether it has fired is read from the log, not memory,
so a restart does not fire it again.

**Skipping requires a reason.** A skipped weld is a quality issue someone has to follow
up on; the reason is stored with the event.

**Problem: unhandled rejections crash Node.** An error inside the async cell loop would
take the whole server down. Each loop is wrapped, and on an unexpected error the run is
marked faulted with "internal error in cell controller" instead.

## Hosting

**Render free tier, Neon free Postgres, and a keep-alive ping from a home server.** The
link has to keep working while an application is being read, at no cost.

**Problem: the obvious keep-alive would drain the database quota.** Neon's free tier
counts compute hours, and a health check that queries the database every 10 minutes
would keep it awake permanently. The keep-alive hits `/api/ping`, which never touches
the database.

**Problem: two safety features cancelled each other out.** "Reset demo data on every boot"
would have deleted the very run that the restart-recovery path is meant to show. Boot
now only inserts missing sample panels and never deletes anything. Reset is a button.

**The public demo has no auth, so samples are locked.** Sample panels are released and
cannot be revised; "Duplicate to edit" makes an editable copy. At most five runs can be
active at once, and starting a new run supersedes an abandoned faulted one.
