// Per-axis σ severity thresholds shared across the listing pages.
//
// "warn" is frontend-only — the yellow stripe in the listings, no
// behavior. "refuse" must stay in sync with the merge gate's refuse
// thresholds in backend/merge_gate.go::mergeSigmaPosRefuseM etc.; the
// frontend uses the matching value here only to color-cue what the merge
// would block on.

export const SIGMA_POS_WARN_M = 0.5;
export const SIGMA_POS_REFUSE_M = 1.0;   // = mergeSigmaPosRefuseM
export const SIGMA_ALT_WARN_M = 0.3;
export const SIGMA_ALT_REFUSE_M = 0.5;   // = mergeSigmaAltRefuseM
export const SIGMA_ANGLE_WARN_RAD = 0.5 * Math.PI / 180;
export const SIGMA_ANGLE_REFUSE_RAD = 2 * Math.PI / 180; // = mergeSigmaAngleRefuseRad
