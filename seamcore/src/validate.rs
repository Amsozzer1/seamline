// `!(v > 0.0)` is deliberate: it also rejects NaN, which `v <= 0.0` would let through.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::spec::{Orientation, Spec, Stiffener, EPS};

pub const MAX_STIFFENERS: usize = 40;
pub const MAX_PLATE_MM: f64 = 30_000.0;
/// Centreline spacing below which a torch is assumed not to fit between stiffeners.
pub const MIN_TORCH_CLEARANCE_MM: f64 = 250.0;
/// Shortest intercostal piece we accept between a crossing and a stiffener end.
pub const MIN_SEGMENT_MM: f64 = 50.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_id: Option<String>,
}

impl Issue {
    pub fn error(code: &str, message: String, part_id: Option<&str>) -> Self {
        Issue { severity: Severity::Error, code: code.into(), message, part_id: part_id.map(Into::into) }
    }
    pub fn warning(code: &str, message: String, part_id: Option<&str>) -> Self {
        Issue { severity: Severity::Warning, code: code.into(), message, part_id: part_id.map(Into::into) }
    }
}

pub fn has_errors(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

pub fn validate(spec: &Spec) -> Vec<Issue> {
    let mut out = Vec::new();
    let p = &spec.plate;

    for (name, v) in [("length", p.length_mm), ("width", p.width_mm), ("thickness", p.thickness_mm)] {
        if !(v > 0.0) || !v.is_finite() {
            out.push(Issue::error("bad_plate", format!("Plate {name} must be greater than 0"), None));
        }
    }
    if p.length_mm > MAX_PLATE_MM || p.width_mm > MAX_PLATE_MM {
        out.push(Issue::error("too_large", format!("Plate is limited to {MAX_PLATE_MM} mm per side"), None));
    }
    if spec.stiffeners.len() > MAX_STIFFENERS {
        out.push(Issue::error(
            "too_many_parts",
            format!("At most {MAX_STIFFENERS} stiffeners per panel ({} given)", spec.stiffeners.len()),
            None,
        ));
    }
    if !out.is_empty() {
        return out;
    }

    let mut seen = HashSet::new();
    for s in &spec.stiffeners {
        let id = Some(s.id.as_str());
        if s.id.trim().is_empty() {
            out.push(Issue::error("bad_id", "Stiffener id must not be empty".into(), None));
        } else if !seen.insert(s.id.clone()) {
            out.push(Issue::error("duplicate_id", format!("Stiffener id {} is used more than once", s.id), id));
        }
        if s.profile != "flat_bar" {
            out.push(Issue::error("unsupported_profile", format!("{}: profile '{}' is not supported (flat_bar only)", s.id, s.profile), id));
        }
        if !(s.height_mm > 0.0) || !(s.thickness_mm > 0.0) || !s.height_mm.is_finite() || !s.thickness_mm.is_finite() {
            out.push(Issue::error("bad_dimension", format!("{}: height and thickness must be greater than 0", s.id), id));
        }
        if !s.start.iter().chain(s.end.iter()).all(|v| v.is_finite()) {
            out.push(Issue::error("bad_dimension", format!("{}: coordinates must be numbers", s.id), id));
            continue;
        }
        if s.length() <= EPS {
            out.push(Issue::error("zero_length", format!("{}: start and end are the same point", s.id), id));
            continue;
        }
        if s.orientation().is_none() {
            out.push(Issue::error("not_axis_aligned", format!("{}: stiffeners must run along x or y", s.id), id));
            continue;
        }
        let inside = |pt: [f64; 2]| pt[0] >= -EPS && pt[0] <= p.length_mm + EPS && pt[1] >= -EPS && pt[1] <= p.width_mm + EPS;
        if !inside(s.start) || !inside(s.end) {
            out.push(Issue::error("out_of_bounds", format!("{}: extends outside the plate", s.id), id));
        }
    }
    if !out.is_empty() {
        return out;
    }

    let (longs, trans) = split_by_orientation(spec);
    for group in [(&longs, Orientation::Longitudinal), (&trans, Orientation::Transverse)] {
        check_parallel(group.0, group.1, &mut out);
    }
    for l in &longs {
        for t in &trans {
            check_junction(l, t, &mut out);
        }
    }
    out
}

pub fn split_by_orientation(spec: &Spec) -> (Vec<&Stiffener>, Vec<&Stiffener>) {
    let mut longs = Vec::new();
    let mut trans = Vec::new();
    for s in &spec.stiffeners {
        match s.orientation() {
            Some(Orientation::Longitudinal) => longs.push(s),
            Some(Orientation::Transverse) => trans.push(s),
            None => {}
        }
    }
    (longs, trans)
}

fn spans_overlap(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 < b.1 - EPS && b.0 < a.1 - EPS
}

fn check_parallel(group: &[&Stiffener], o: Orientation, out: &mut Vec<Issue>) {
    for (i, a) in group.iter().enumerate() {
        for b in &group[i + 1..] {
            if !spans_overlap(a.span(o), b.span(o)) {
                continue;
            }
            let gap = (a.offset(o) - b.offset(o)).abs();
            if gap < (a.thickness_mm + b.thickness_mm) / 2.0 - EPS {
                out.push(Issue::error("overlap", format!("{} and {} overlap", a.id, b.id), Some(&b.id)));
            } else if gap < MIN_TORCH_CLEARANCE_MM {
                out.push(Issue::warning(
                    "tight_spacing",
                    format!("{} and {} are {gap:.0} mm apart; under {MIN_TORCH_CLEARANCE_MM:.0} mm the torch may not fit", a.id, b.id),
                    Some(&b.id),
                ));
            }
        }
    }
}

/// A longitudinal and a transverse either cross cleanly (the transverse is cut into
/// intercostal pieces on both sides) or do not touch at all. Anything in between is a
/// T-junction or near-miss that this model has no seam rule for.
fn check_junction(l: &Stiffener, t: &Stiffener, out: &mut Vec<Issue>) {
    let (lx0, lx1) = l.span(Orientation::Longitudinal);
    let ly = l.offset(Orientation::Longitudinal);
    let (ty0, ty1) = t.span(Orientation::Transverse);
    let tx = t.offset(Orientation::Transverse);
    let (lt, tt) = (l.thickness_mm / 2.0, t.thickness_mm / 2.0);

    let touch_x = tx + tt >= lx0 - EPS && tx - tt <= lx1 + EPS;
    let touch_y = ly + lt >= ty0 - EPS && ly - lt <= ty1 + EPS;
    if !(touch_x && touch_y) {
        return;
    }
    let l_passes = lx0 < tx - tt - EPS && lx1 > tx + tt + EPS;
    let t_passes = ty0 + MIN_SEGMENT_MM <= ly - lt + EPS && ty1 - MIN_SEGMENT_MM >= ly + lt - EPS;
    if !(l_passes && t_passes) {
        out.push(Issue::error(
            "junction_unsupported",
            format!("{} and {} meet without fully crossing; only full crossings are supported", t.id, l.id),
            Some(&t.id),
        ));
    }
}
