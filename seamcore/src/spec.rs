use serde::{Deserialize, Serialize};

/// Geometric tolerance in millimetres.
pub const EPS: f64 = 1e-6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub name: String,
    pub plate: Plate,
    pub stiffeners: Vec<Stiffener>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plate {
    pub length_mm: f64,
    pub width_mm: f64,
    pub thickness_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stiffener {
    pub id: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    pub height_mm: f64,
    pub thickness_mm: f64,
    pub start: [f64; 2],
    pub end: [f64; 2],
}

fn default_profile() -> String {
    "flat_bar".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    /// Runs along the plate length (x).
    Longitudinal,
    /// Runs across the plate width (y).
    Transverse,
}

impl Stiffener {
    /// `None` when the stiffener is not axis-aligned or has zero length.
    pub fn orientation(&self) -> Option<Orientation> {
        let dx = (self.end[0] - self.start[0]).abs();
        let dy = (self.end[1] - self.start[1]).abs();
        if dx > EPS && dy <= EPS {
            Some(Orientation::Longitudinal)
        } else if dy > EPS && dx <= EPS {
            Some(Orientation::Transverse)
        } else {
            None
        }
    }

    /// Position of the centreline across its own axis: y for longitudinals, x for transverses.
    pub fn offset(&self, o: Orientation) -> f64 {
        match o {
            Orientation::Longitudinal => self.start[1],
            Orientation::Transverse => self.start[0],
        }
    }

    /// Extent along its own axis, sorted low to high.
    pub fn span(&self, o: Orientation) -> (f64, f64) {
        let (a, b) = match o {
            Orientation::Longitudinal => (self.start[0], self.end[0]),
            Orientation::Transverse => (self.start[1], self.end[1]),
        };
        (a.min(b), a.max(b))
    }

    pub fn length(&self) -> f64 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        (dx * dx + dy * dy).sqrt()
    }
}
