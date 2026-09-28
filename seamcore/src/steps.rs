use std::collections::HashMap;

use crate::seams::Seam;
use crate::sequence::{Portion, Step, StepKind};
use crate::validate::Issue;

/// Check an edited plan against the seams of its spec: every seam is tacked exactly once,
/// welded exactly once (either full or as both halves), and never welded before its tack.
pub fn check_steps(seams: &[Seam], steps: &[Step]) -> Vec<Issue> {
    let mut out = Vec::new();
    let known: HashMap<&str, &Seam> = seams.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut tacked_at: HashMap<&str, usize> = HashMap::new();
    let mut portions: HashMap<&str, Vec<Portion>> = HashMap::new();

    for (i, step) in steps.iter().enumerate() {
        let id = step.seam_id.as_str();
        if !known.contains_key(id) {
            out.push(Issue::error("unknown_seam", format!("Step {}: seam {id} does not exist", i + 1), Some(id)));
            continue;
        }
        match step.kind {
            StepKind::Tack => {
                if tacked_at.insert(id, i).is_some() {
                    out.push(Issue::error("duplicate_tack", format!("Seam {id} is tacked more than once"), Some(id)));
                }
            }
            StepKind::Weld => {
                if !tacked_at.contains_key(id) {
                    out.push(Issue::error("weld_before_tack", format!("Step {}: seam {id} is welded before it is tacked", i + 1), Some(id)));
                }
                portions.entry(id).or_default().push(step.portion);
            }
        }
    }

    for s in seams {
        let id = s.id.as_str();
        if !tacked_at.contains_key(id) {
            out.push(Issue::error("missing_tack", format!("Seam {id} is never tacked"), Some(id)));
        }
        let mut p = portions.get(id).cloned().unwrap_or_default();
        p.sort_by_key(|x| *x as u8);
        let ok = p == [Portion::Full] || p == [Portion::FirstHalf, Portion::SecondHalf];
        if !ok {
            let msg = if p.is_empty() {
                format!("Seam {id} is never welded")
            } else {
                format!("Seam {id} must be welded exactly once, in full or as both halves")
            };
            out.push(Issue::error(if p.is_empty() { "missing_weld" } else { "bad_weld_coverage" }, msg, Some(id)));
        }
    }
    out
}
