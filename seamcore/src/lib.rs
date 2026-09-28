//! seamcore: weld seam extraction and sequencing for flat stiffened panels.
//!
//! The same crate is compiled to WebAssembly for the browser and for the Node server,
//! so both sides agree on what a panel's seams are and whether a plan is valid.
//! The WASM boundary is plain JSON strings in and out.

pub mod seams;
pub mod sequence;
pub mod spec;
pub mod steps;
pub mod validate;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use seams::Seam;
use sequence::Step;
use spec::Spec;
use validate::{has_errors, Issue};

#[derive(Debug, Serialize)]
pub struct Plan {
    pub issues: Vec<Issue>,
    pub seams: Vec<Seam>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub issues: Vec<Issue>,
}

pub fn parse_spec(json: &str) -> Result<Spec, Issue> {
    serde_json::from_str(json).map_err(|e| Issue::error("invalid_spec", format!("Spec is not valid: {e}"), None))
}

pub fn plan_spec(spec: &Spec) -> Plan {
    let issues = validate::validate(spec);
    if has_errors(&issues) {
        return Plan { issues, seams: vec![], steps: vec![] };
    }
    let seams = seams::extract(spec);
    let steps = sequence::sequence(spec, &seams);
    Plan { issues, seams, steps }
}

pub fn check_spec_steps(spec: &Spec, steps: &[Step]) -> Check {
    let plan = plan_spec(spec);
    if has_errors(&plan.issues) {
        return Check { issues: plan.issues };
    }
    let mut issues = plan.issues;
    issues.extend(steps::check_steps(&plan.seams, steps));
    Check { issues }
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| r#"{"issues":[{"severity":"error","code":"internal","message":"serialization failed"}]}"#.into())
}

/// `plan(spec_json) -> {issues, seams, steps}`
#[wasm_bindgen]
pub fn plan(spec_json: &str) -> String {
    match parse_spec(spec_json) {
        Ok(spec) => to_json(&plan_spec(&spec)),
        Err(issue) => to_json(&Plan { issues: vec![issue], seams: vec![], steps: vec![] }),
    }
}

/// `check(spec_json, steps_json) -> {issues}`
#[wasm_bindgen]
pub fn check(spec_json: &str, steps_json: &str) -> String {
    let spec = match parse_spec(spec_json) {
        Ok(s) => s,
        Err(issue) => return to_json(&Check { issues: vec![issue] }),
    };
    let steps: Vec<Step> = match serde_json::from_str(steps_json) {
        Ok(s) => s,
        Err(e) => return to_json(&Check { issues: vec![Issue::error("invalid_steps", format!("Steps are not valid: {e}"), None)] }),
    };
    to_json(&check_spec_steps(&spec, &steps))
}
