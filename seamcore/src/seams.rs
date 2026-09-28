use serde::{Deserialize, Serialize};

use crate::spec::{Orientation, Spec, Stiffener};
use crate::validate::split_by_orientation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeamKind {
    /// Stiffener to plate, along the foot of the stiffener.
    Fillet,
    /// Vertical weld where an intercostal piece meets a continuous stiffener.
    Joint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Seam {
    pub id: String,
    pub kind: SeamKind,
    /// Seams welded as a balanced pair (the two faces of one piece) share a group.
    pub group: String,
    pub side: String,
    pub parts: [String; 2],
    /// Millimetres; z = 0 is the top face of the plate.
    pub start: [f64; 3],
    pub end: [f64; 3],
    pub length_mm: f64,
}

impl Seam {
    pub fn midpoint(&self) -> [f64; 3] {
        [
            (self.start[0] + self.end[0]) / 2.0,
            (self.start[1] + self.end[1]) / 2.0,
            (self.start[2] + self.end[2]) / 2.0,
        ]
    }
}

fn seam(id: String, kind: SeamKind, group: String, side: &str, parts: [&str; 2], start: [f64; 3], end: [f64; 3]) -> Seam {
    let d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    Seam {
        id,
        kind,
        group,
        side: side.into(),
        parts: [parts[0].into(), parts[1].into()],
        start,
        end,
        length_mm: (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt(),
    }
}

/// Derive every weld seam from a spec that has already passed validation.
///
/// Longitudinals are continuous. Transverses are intercostal: each crossing cuts the
/// transverse into pieces, so its plate fillets are split around the longitudinal and
/// each piece end is welded to the longitudinal web on both of its faces.
pub fn extract(spec: &Spec) -> Vec<Seam> {
    let plate_id = "PLATE";
    let (longs, trans) = split_by_orientation(spec);
    let mut out = Vec::new();

    for l in &longs {
        let (x0, x1) = l.span(Orientation::Longitudinal);
        let y = l.offset(Orientation::Longitudinal);
        let h = l.thickness_mm / 2.0;
        for (side, yy) in [("A", y - h), ("B", y + h)] {
            out.push(seam(
                format!("{}-{side}", l.id),
                SeamKind::Fillet,
                l.id.clone(),
                side,
                [&l.id, plate_id],
                [x0, yy, 0.0],
                [x1, yy, 0.0],
            ));
        }
    }

    for t in &trans {
        let (y0, y1) = t.span(Orientation::Transverse);
        let x = t.offset(Orientation::Transverse);
        let h = t.thickness_mm / 2.0;

        let mut crossing: Vec<&&Stiffener> = longs
            .iter()
            .filter(|l| {
                let (lx0, lx1) = l.span(Orientation::Longitudinal);
                let ly = l.offset(Orientation::Longitudinal);
                lx0 < x && lx1 > x && ly > y0 && ly < y1
            })
            .collect();
        crossing.sort_by(|a, b| a.offset(Orientation::Longitudinal).total_cmp(&b.offset(Orientation::Longitudinal)));

        // Intercostal pieces between crossings.
        let mut cursor = y0;
        let mut pieces = Vec::new();
        for l in &crossing {
            let ly = l.offset(Orientation::Longitudinal);
            let lt = l.thickness_mm / 2.0;
            pieces.push((cursor, ly - lt));
            cursor = ly + lt;
        }
        pieces.push((cursor, y1));

        for (i, (a, b)) in pieces.iter().enumerate() {
            let group = if pieces.len() == 1 { t.id.clone() } else { format!("{}.{}", t.id, i + 1) };
            for (side, xx) in [("A", x - h), ("B", x + h)] {
                let id = if pieces.len() == 1 { format!("{}-{side}", t.id) } else { format!("{}-{side}{}", t.id, i + 1) };
                out.push(seam(id, SeamKind::Fillet, group.clone(), side, [&t.id, plate_id], [xx, *a, 0.0], [xx, *b, 0.0]));
            }
        }

        // Piece ends against each continuous longitudinal: south face and north face,
        // each welded on both faces of the transverse web.
        for l in &crossing {
            let ly = l.offset(Orientation::Longitudinal);
            let lt = l.thickness_mm / 2.0;
            let z = t.height_mm.min(l.height_mm);
            for (face, yy) in [("S", ly - lt), ("N", ly + lt)] {
                let group = format!("J-{}-{}-{face}", t.id, l.id);
                for (side, xx) in [("A", x - h), ("B", x + h)] {
                    out.push(seam(
                        format!("{group}{side}"),
                        SeamKind::Joint,
                        group.clone(),
                        side,
                        [&t.id, &l.id],
                        [xx, yy, 0.0],
                        [xx, yy, z],
                    ));
                }
            }
        }
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}
