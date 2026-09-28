use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::seams::{Seam, SeamKind};
use crate::spec::Spec;

/// Fillets longer than this that pass through the panel centre are welded as two halves,
/// each starting at the centre and running outward.
pub const SPLIT_MIN_MM: f64 = 2000.0;
/// Seam groups within the same distance band from the centre are ordered nearest-next.
pub const BAND_MM: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Tack,
    Weld,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Portion {
    Full,
    /// start -> midpoint of the seam
    FirstHalf,
    /// midpoint -> end of the seam
    SecondHalf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Travel from the lower-coordinate end of the portion towards the higher.
    Forward,
    Reverse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub kind: StepKind,
    pub seam_id: String,
    pub portion: Portion,
    pub direction: Direction,
}

fn dist2(a: [f64; 3], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    (dx * dx + dy * dy).sqrt()
}

/// Whether the sequencer welds this seam as two halves from the panel centre outward.
pub fn is_split(seam: &Seam, center: [f64; 2]) -> bool {
    if seam.kind != SeamKind::Fillet || seam.length_mm <= SPLIT_MIN_MM {
        return false;
    }
    let along_x = (seam.end[0] - seam.start[0]).abs() > (seam.end[1] - seam.start[1]).abs();
    let (c, a, b) = if along_x {
        (center[0], seam.start[0], seam.end[0])
    } else {
        (center[1], seam.start[1], seam.end[1])
    };
    c > a.min(b) && c < a.max(b)
}

struct Group<'a> {
    key: &'a str,
    seams: Vec<&'a Seam>,
    mid: [f64; 3],
}

/// Default weld order. Deliberately a small set of explainable heuristics rather than an
/// optimiser: tack everything first, then weld from the centre outward, alternating the
/// two faces of each piece to balance heat input, nearest-next within a distance band.
pub fn sequence(spec: &Spec, seams: &[Seam]) -> Vec<Step> {
    let center = [spec.plate.length_mm / 2.0, spec.plate.width_mm / 2.0];

    let mut by_group: BTreeMap<&str, Vec<&Seam>> = BTreeMap::new();
    for s in seams {
        by_group.entry(s.group.as_str()).or_default().push(s);
    }
    let mut groups: Vec<Group> = by_group
        .into_iter()
        .map(|(key, mut seams)| {
            seams.sort_by(|a, b| a.side.cmp(&b.side));
            let n = seams.len() as f64;
            let mut mid = [0.0; 3];
            for s in &seams {
                let m = s.midpoint();
                for k in 0..3 {
                    mid[k] += m[k] / n;
                }
            }
            Group { key, seams, mid }
        })
        .collect();

    // Order groups: by distance band from the centre, then nearest to the previous group.
    let band = |g: &Group| (dist2(g.mid, center) / BAND_MM).floor() as i64;
    groups.sort_by(|a, b| band(a).cmp(&band(b)).then(a.key.cmp(b.key)));
    let mut ordered: Vec<Group> = Vec::with_capacity(groups.len());
    let mut cursor = center;
    while !groups.is_empty() {
        let b0 = band(&groups[0]);
        let (idx, _) = groups
            .iter()
            .enumerate()
            .take_while(|(_, g)| band(g) == b0)
            .min_by(|(_, a), (_, b)| dist2(a.mid, cursor).total_cmp(&dist2(b.mid, cursor)).then(a.key.cmp(b.key)))
            .expect("non-empty");
        let g = groups.remove(idx);
        cursor = [g.mid[0], g.mid[1]];
        ordered.push(g);
    }

    let mut steps = Vec::new();
    for g in &ordered {
        for s in &g.seams {
            steps.push(Step { kind: StepKind::Tack, seam_id: s.id.clone(), portion: Portion::Full, direction: Direction::Forward });
        }
    }
    for (i, g) in ordered.iter().enumerate() {
        let mut sides: Vec<&Seam> = g.seams.clone();
        if i % 2 == 1 {
            sides.reverse();
        }
        if sides.iter().all(|s| is_split(s, center)) {
            // Both faces, first half each, then both faces, second half each.
            for s in &sides {
                steps.push(Step { kind: StepKind::Weld, seam_id: s.id.clone(), portion: Portion::FirstHalf, direction: Direction::Reverse });
            }
            for s in &sides {
                steps.push(Step { kind: StepKind::Weld, seam_id: s.id.clone(), portion: Portion::SecondHalf, direction: Direction::Forward });
            }
        } else {
            for s in &sides {
                let away = if dist2(s.start, center) <= dist2(s.end, center) { Direction::Forward } else { Direction::Reverse };
                steps.push(Step { kind: StepKind::Weld, seam_id: s.id.clone(), portion: Portion::Full, direction: away });
            }
        }
    }
    steps
}
