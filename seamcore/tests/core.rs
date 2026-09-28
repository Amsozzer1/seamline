use seamcore::seams::SeamKind;
use seamcore::sequence::{Portion, Step, StepKind};
use seamcore::spec::Spec;
use seamcore::validate::{has_errors, Severity};
use seamcore::{check, check_spec_steps, plan, plan_spec};

const FLAT: &str = include_str!("../../samples/mp-101-flat.json");
const GRID: &str = include_str!("../../samples/mp-104-grid.json");
const DECK: &str = include_str!("../../samples/mp-220-deck.json");
const INVALID: &str = include_str!("../../samples/mp-900-invalid.json");

fn spec(json: &str) -> Spec {
    serde_json::from_str(json).unwrap()
}

fn codes(json: &str) -> Vec<String> {
    plan_spec(&spec(json)).issues.into_iter().map(|i| i.code).collect()
}

fn with_stiffeners(stiffeners: &str) -> String {
    format!(r#"{{"name":"t","plate":{{"length_mm":6000,"width_mm":2400,"thickness_mm":10}},"stiffeners":[{stiffeners}]}}"#)
}

// ---- seam extraction ----

#[test]
fn flat_bars_give_two_fillets_each() {
    let p = plan_spec(&spec(FLAT));
    assert!(p.issues.is_empty(), "{:?}", p.issues);
    assert_eq!(p.seams.len(), 6);
    assert!(p.seams.iter().all(|s| s.kind == SeamKind::Fillet && (s.length_mm - 6000.0).abs() < 1e-9));
}

#[test]
fn crossing_splits_transverse_and_adds_four_joints() {
    let p = plan_spec(&spec(GRID));
    assert!(!has_errors(&p.issues));
    let fillets = p.seams.iter().filter(|s| s.kind == SeamKind::Fillet).count();
    let joints = p.seams.iter().filter(|s| s.kind == SeamKind::Joint).count();
    // 2 longitudinals x 2 faces + 3 transverse pieces x 2 faces
    assert_eq!(fillets, 4 + 6);
    // 2 crossings x (south + north piece end) x 2 transverse faces
    assert_eq!(joints, 8);
    assert_eq!(p.seams.len(), 18);
}

#[test]
fn transverse_pieces_plus_gaps_equal_its_length() {
    let p = plan_spec(&spec(GRID));
    let a_side: f64 = p.seams.iter().filter(|s| s.id.starts_with("T1-A")).map(|s| s.length_mm).sum();
    // two crossings, each removing the 12 mm longitudinal web
    assert!((a_side + 2.0 * 12.0 - 2400.0).abs() < 1e-9, "{a_side}");
}

#[test]
fn joint_height_is_the_lower_stiffener() {
    let p = plan_spec(&spec(GRID));
    for j in p.seams.iter().filter(|s| s.kind == SeamKind::Joint) {
        assert!((j.length_mm - 150.0).abs() < 1e-9);
    }
}

#[test]
fn deck_sample_counts() {
    let p = plan_spec(&spec(DECK));
    assert!(!has_errors(&p.issues));
    // 3 L x 2 + 2 T x 4 pieces x 2 + 6 crossings x 4
    assert_eq!(p.seams.len(), 6 + 16 + 24);
}

// ---- validation ----

#[test]
fn invalid_sample_reports_bounds_and_spacing() {
    let p = plan_spec(&spec(INVALID));
    assert!(p.issues.iter().any(|i| i.code == "out_of_bounds" && i.part_id.as_deref() == Some("L3")));
    assert!(p.seams.is_empty() && p.steps.is_empty());
}

#[test]
fn tight_spacing_is_a_warning_only() {
    let s = with_stiffeners(
        r#"{"id":"L1","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,600]},
           {"id":"L2","height_mm":150,"thickness_mm":10,"start":[0,780],"end":[6000,780]}"#,
    );
    let p = plan_spec(&spec(&s));
    assert!(p.issues.iter().all(|i| i.severity == Severity::Warning));
    assert!(p.issues.iter().any(|i| i.code == "tight_spacing"));
    assert_eq!(p.seams.len(), 4);
}

#[test]
fn each_error_case_has_its_code() {
    let cases = [
        (r#"{"id":"A","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[0,600]}"#, "zero_length"),
        (r#"{"id":"A","height_mm":0,"thickness_mm":10,"start":[0,600],"end":[6000,600]}"#, "bad_dimension"),
        (r#"{"id":"A","height_mm":150,"thickness_mm":-1,"start":[0,600],"end":[6000,600]}"#, "bad_dimension"),
        (r#"{"id":"A","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,900]}"#, "not_axis_aligned"),
        (r#"{"id":"A","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[7000,600]}"#, "out_of_bounds"),
        (r#"{"id":"A","profile":"tee","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,600]}"#, "unsupported_profile"),
        (
            r#"{"id":"A","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,600]},
               {"id":"B","height_mm":150,"thickness_mm":10,"start":[0,605],"end":[6000,605]}"#,
            "overlap",
        ),
        (
            r#"{"id":"A","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,600]},
               {"id":"A","height_mm":150,"thickness_mm":10,"start":[0,1600],"end":[6000,1600]}"#,
            "duplicate_id",
        ),
        (
            // transverse ends on the longitudinal: a T-junction
            r#"{"id":"L","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[6000,600]},
               {"id":"T","height_mm":150,"thickness_mm":10,"start":[3000,605],"end":[3000,2400]}"#,
            "junction_unsupported",
        ),
        (
            // longitudinal stops at the transverse
            r#"{"id":"L","height_mm":150,"thickness_mm":10,"start":[0,600],"end":[3000,600]},
               {"id":"T","height_mm":150,"thickness_mm":10,"start":[3000,0],"end":[3000,2400]}"#,
            "junction_unsupported",
        ),
    ];
    for (stiffeners, code) in cases {
        let c = codes(&with_stiffeners(stiffeners));
        assert!(c.iter().any(|x| x == code), "expected {code}, got {c:?} for {stiffeners}");
    }
}

#[test]
fn plate_and_size_limits() {
    let bad_plate = r#"{"name":"t","plate":{"length_mm":0,"width_mm":2400,"thickness_mm":10},"stiffeners":[]}"#;
    assert!(codes(bad_plate).contains(&"bad_plate".to_string()));
    let many: Vec<String> = (0..41)
        .map(|i| format!(r#"{{"id":"L{i}","height_mm":150,"thickness_mm":10,"start":[0,{}],"end":[6000,{}]}}"#, 10 + i * 50, 10 + i * 50))
        .collect();
    assert!(codes(&with_stiffeners(&many.join(","))).contains(&"too_many_parts".to_string()));
}

#[test]
fn garbage_input_is_an_error_not_a_panic() {
    for input in ["", "null", "{", "[]", r#"{"name":1}"#, r#"{"name":"x","plate":{"length_mm":"a"}}"#] {
        let out: serde_json::Value = serde_json::from_str(&plan(input)).unwrap();
        assert_eq!(out["issues"][0]["code"], "invalid_spec", "{input}");
        if input != "[]" {
            let out: serde_json::Value = serde_json::from_str(&check(FLAT, input)).unwrap();
            assert_eq!(out["issues"][0]["code"], "invalid_steps", "{input}");
        }
    }
    // An empty step list parses, but fails coverage.
    let out: serde_json::Value = serde_json::from_str(&check(FLAT, "[]")).unwrap();
    assert_eq!(out["issues"][0]["code"], "missing_tack");
}

// ---- sequencing ----

#[test]
fn all_tacks_before_any_weld() {
    for json in [FLAT, GRID, DECK] {
        let p = plan_spec(&spec(json));
        let first_weld = p.steps.iter().position(|s| s.kind == StepKind::Weld).unwrap();
        assert!(p.steps[first_weld..].iter().all(|s| s.kind == StepKind::Weld));
        assert_eq!(first_weld, p.seams.len());
    }
}

#[test]
fn default_plan_passes_its_own_check() {
    for json in [FLAT, GRID, DECK] {
        let s = spec(json);
        let p = plan_spec(&s);
        let c = check_spec_steps(&s, &p.steps);
        assert!(!has_errors(&c.issues), "{:?}", c.issues);
    }
}

#[test]
fn long_centre_fillets_are_split_and_start_at_the_centre() {
    let p = plan_spec(&spec(FLAT));
    let welds: Vec<&Step> = p.steps.iter().filter(|s| s.kind == StepKind::Weld).collect();
    // 6 fillets, each crossing x = 3000 and longer than 2 m -> 12 half welds
    assert_eq!(welds.len(), 12);
    assert!(welds.iter().all(|s| s.portion != Portion::Full));
    // centre stiffener first
    assert!(welds[0].seam_id.starts_with("L2"));
}

#[test]
fn faces_alternate_between_groups() {
    let p = plan_spec(&spec(DECK));
    let welds: Vec<&Step> = p.steps.iter().filter(|s| s.kind == StepKind::Weld && s.portion != Portion::SecondHalf).collect();
    // consecutive groups start on opposite faces
    let sides: Vec<char> = welds.iter().step_by(2).map(|s| s.seam_id.chars().last().unwrap()).collect();
    assert!(sides.windows(2).any(|w| w[0] != w[1]));
}

#[test]
fn sequencing_is_deterministic() {
    for json in [FLAT, GRID, DECK] {
        assert_eq!(plan(json), plan(json));
    }
}

// ---- step checking ----

#[test]
fn check_catches_bad_edits() {
    let s = spec(GRID);
    let p = plan_spec(&s);

    let mut missing = p.steps.clone();
    missing.retain(|x| !(x.kind == StepKind::Tack && x.seam_id == "T1-A1"));
    assert!(check_spec_steps(&s, &missing).issues.iter().any(|i| i.code == "missing_tack"));

    let mut dup = p.steps.clone();
    dup.push(dup.last().unwrap().clone());
    assert!(check_spec_steps(&s, &dup).issues.iter().any(|i| i.code == "bad_weld_coverage"));

    let mut early = p.steps.clone();
    let w = early.iter().position(|x| x.kind == StepKind::Weld).unwrap();
    let weld = early.remove(w);
    early.insert(0, weld);
    assert!(check_spec_steps(&s, &early).issues.iter().any(|i| i.code == "weld_before_tack"));

    let mut unknown = p.steps.clone();
    unknown[0].seam_id = "NOPE".into();
    assert!(check_spec_steps(&s, &unknown).issues.iter().any(|i| i.code == "unknown_seam"));
}

#[test]
fn reordering_welds_is_allowed() {
    let s = spec(GRID);
    let mut steps = plan_spec(&s).steps;
    let n = steps.len();
    steps.swap(n - 1, n - 2);
    assert!(!has_errors(&check_spec_steps(&s, &steps).issues));
}
