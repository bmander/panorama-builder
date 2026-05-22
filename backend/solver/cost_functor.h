//go:build !noceres

// Templated math used inside Ceres autodiff cost functors. Mirrors
// solver/project.go::ProjectPOI and solver/geo.go::BearingENU so the
// residual matches the Go reference implementation observation-for-observation.
//
// Every function is templated on T so it can be evaluated with
// ceres::Jet<double, N> (for autodiff) or plain double (for residual-only).
#ifndef PANORAMA_COST_FUNCTOR_H
#define PANORAMA_COST_FUNCTOR_H

#include <cmath>
#include <algorithm>

namespace pc {

// Mirrors solver/solve.go::minCosEl. Floors cos(elTgt) so the polar
// singularity in the az weighting stays bounded.
constexpr double kMinCosEl = 1e-6;

// Mirrors solver/project.go::tiltClampEps.
constexpr double kTiltClampEps = 1e-6;

constexpr double kPi = 3.14159265358979323846;
constexpr double kHalfPi = kPi / 2.0;

// Refraction coefficient k from solver/geo.go::RefractionK.
constexpr double kRefractionK = 0.14;

template <typename T>
inline T ClampTilt(const T& t) {
    using std::min; using std::max;
    const T lo = T(-kHalfPi + kTiltClampEps);
    const T hi = T( kHalfPi - kTiltClampEps);
    if (t > hi) return hi;
    if (t < lo) return lo;
    return t;
}

// WrapPi via atan2(sin, cos) — smooth and exactly differentiable everywhere.
// Mirrors solver/geo.go::WrapPi for inputs in the usual residual range; for
// large inputs both definitions agree mod 2π and produce values in (-π, π].
template <typename T>
inline T WrapPi(const T& a) {
    using std::sin; using std::cos; using std::atan2;
    return atan2(sin(a), cos(a));
}

// Convert ENU offset to viewer-frame (az, el). Mirrors solver/geo.go::BearingENU.
// Viewer frame: +X east, +Y up, -Z north (forward at az=0).
template <typename T>
inline void BearingENU(const T& dE, const T& dN, const T& dU, T* out_az, T* out_el) {
    using std::sqrt; using std::atan2; using std::asin;
    const T x = dE;
    const T y = dU;
    const T z = -dN;
    const T length = sqrt(x*x + y*y + z*z);
    *out_az = atan2(-x, -z);
    T r = y / length;
    if (r > T(1))  r = T(1);
    if (r < T(-1)) r = T(-1);
    *out_el = asin(r);
}

// Project an image-plane (u, v) through a photo's pose to viewer-frame
// (az, el). Inverts Brown-Conrady distortion when K1/K2 are nonzero.
// Mirrors solver/project.go::ProjectPOI.
template <typename T>
inline void ProjectPOI(const T& photo_az, const T& photo_tilt, const T& photo_roll,
                       const T& size_rad, double aspect,
                       const T& K1, const T& K2,
                       double u, double v,
                       T* out_az, T* out_el) {
    using std::sqrt; using std::sin; using std::cos; using std::tan;
    using std::atan2; using std::asin;

    const T azP  = photo_az;
    const T altP = ClampTilt(photo_tilt);
    const T roll = photo_roll;

    const T ca = cos(altP), sa = sin(altP);
    const T caz = cos(azP), saz = sin(azP);
    const T cx = -ca * saz;
    const T cy = sa;
    const T cz = -ca * caz;

    const T lxX = -cz;
    const T lxZ = cx;
    const T lxLen = sqrt(lxX*lxX + lxZ*lxZ);
    const T baseXx = lxX / lxLen;
    const T baseXz = lxZ / lxLen;

    const T lyX = -cy * cx;
    const T lyY = cz*cz + cx*cx;
    const T lyZ = -cy * cz;
    const T lyLen = sqrt(lyX*lyX + lyY*lyY + lyZ*lyZ);
    const T baseYx = lyX / lyLen;
    const T baseYy = lyY / lyLen;
    const T baseYz = lyZ / lyLen;

    const T cr = cos(roll), sr = sin(roll);
    const T localXx = cr*baseXx + sr*baseYx;
    const T localXy = sr * baseYy;
    const T localXz = cr*baseXz + sr*baseYz;
    const T localYx = -sr*baseXx + cr*baseYx;
    const T localYy = cr * baseYy;
    const T localYz = -sr*baseXz + cr*baseYz;

    const T W = T(2) * tan(size_rad / T(2));
    const T H = W / T(aspect);
    T dx = T(u - 0.5) * W;
    T dy = T(v - 0.5) * H;

    // Brown-Conrady inverse via 5-iter fixed-point. Always run the loop so
    // autodiff Jacobians stay smooth across K1=K2=0 (the loop is a no-op then
    // since f = 1 and x/y are unchanged). Mirrors solver/project.go.
    {
        const T xd = dx, yd = dy;
        T x = xd, y = yd;
        for (int i = 0; i < 5; ++i) {
            const T r2 = x*x + y*y;
            const T f = T(1) + K1*r2 + K2*r2*r2;
            x = xd / f;
            y = yd / f;
        }
        dx = x;
        dy = y;
    }

    const T px = cx + dx*localXx + dy*localYx;
    const T py = cy + dx*localXy + dy*localYy;
    const T pz = cz + dx*localXz + dy*localYz;

    const T length = sqrt(px*px + py*py + pz*pz);
    *out_az = atan2(-px, -pz);
    T r = py / length;
    if (r > T(1))  r = T(1);
    if (r < T(-1)) r = T(-1);
    *out_el = asin(r);
}

// Anchor: per-entity precomputed double constants captured at problem-build
// time. ECEF position + ENU basis vectors in ECEF + local Earth radius for
// the refraction term.
struct Anchor {
    double ecef[3];
    double east[3];
    double north[3];
    double up[3];
    double rlocal;
};

// WGS84 + ENU basis. Mirrors solver/geo.go::{LLAToECEF, LocalENUBasis,
// localMeanRadius}. Always called with plain double — anchors are constants.
inline Anchor MakeAnchor(double lat_deg, double lng_deg, double alt) {
    constexpr double a  = 6378137.0;
    constexpr double f  = 1.0 / 298.257223563;
    constexpr double e2 = f * (2.0 - f);

    const double lat = lat_deg * kPi / 180.0;
    const double lng = lng_deg * kPi / 180.0;
    const double sinLat = std::sin(lat), cosLat = std::cos(lat);
    const double sinLng = std::sin(lng), cosLng = std::cos(lng);
    const double denom = 1.0 - e2 * sinLat * sinLat;
    const double N = a / std::sqrt(denom);

    Anchor anc{};
    anc.ecef[0] = (N + alt) * cosLat * cosLng;
    anc.ecef[1] = (N + alt) * cosLat * sinLng;
    anc.ecef[2] = (N * (1.0 - e2) + alt) * sinLat;

    anc.east[0]  = -sinLng;          anc.east[1]  =  cosLng;          anc.east[2]  = 0.0;
    anc.north[0] = -sinLat * cosLng; anc.north[1] = -sinLat * sinLng; anc.north[2] = cosLat;
    anc.up[0]    =  cosLat * cosLng; anc.up[1]    =  cosLat * sinLng; anc.up[2]    = sinLat;

    const double M = a * (1.0 - e2) / std::pow(denom, 1.5);
    anc.rlocal = std::sqrt(M * N);
    return anc;
}

// ObsCost: 2-residual functor for one (photo, control point, u, v) tuple.
// Captures station and CP anchor constants. The seven parameter blocks split
// the optimized variables along their natural sharing boundaries:
//   sE, sN, sU : station east/north/up offset (1-D blocks)
//   photo      : (az, tilt, roll, sizeRad, K1, K2)  (6-vector)
//   cE, cN, cU : CP east/north/up offset (1-D blocks; possibly aliased to
//                another CP's blocks via union-find on the Go side)
struct ObsCost {
    Anchor s;       // station anchor
    Anchor c;       // CP anchor
    double aspect;
    double u, v;

    ObsCost(const Anchor& s_in, const Anchor& c_in, double aspect_in,
            double u_in, double v_in)
        : s(s_in), c(c_in), aspect(aspect_in), u(u_in), v(v_in) {}

    template <typename T>
    bool operator()(const T* const sE, const T* const sN, const T* const sU,
                    const T* const photo,
                    const T* const cE, const T* const cN, const T* const cU,
                    T* residuals) const {
        using std::cos;

        // Station effective ECEF = anchor + sE*east + sN*north + sU*up.
        const T sx = T(s.ecef[0]) + sE[0]*T(s.east[0]) + sN[0]*T(s.north[0]) + sU[0]*T(s.up[0]);
        const T sy = T(s.ecef[1]) + sE[0]*T(s.east[1]) + sN[0]*T(s.north[1]) + sU[0]*T(s.up[1]);
        const T sz = T(s.ecef[2]) + sE[0]*T(s.east[2]) + sN[0]*T(s.north[2]) + sU[0]*T(s.up[2]);

        const T cx = T(c.ecef[0]) + cE[0]*T(c.east[0]) + cN[0]*T(c.north[0]) + cU[0]*T(c.up[0]);
        const T cy = T(c.ecef[1]) + cE[0]*T(c.east[1]) + cN[0]*T(c.north[1]) + cU[0]*T(c.up[1]);
        const T cz = T(c.ecef[2]) + cE[0]*T(c.east[2]) + cN[0]*T(c.north[2]) + cU[0]*T(c.up[2]);

        const T dx = cx - sx;
        const T dy = cy - sy;
        const T dz = cz - sz;

        // Project into station's ENU.
        T dE = dx*T(s.east[0])  + dy*T(s.east[1])  + dz*T(s.east[2]);
        T dN = dx*T(s.north[0]) + dy*T(s.north[1]) + dz*T(s.north[2]);
        T dU = dx*T(s.up[0])    + dy*T(s.up[1])    + dz*T(s.up[2]);
        dU += T(kRefractionK) * (dE*dE + dN*dN) / T(2.0 * s.rlocal);

        T azTgt, elTgt;
        BearingENU(dE, dN, dU, &azTgt, &elTgt);

        T azPred, elPred;
        ProjectPOI(photo[0], photo[1], photo[2], photo[3], aspect,
                   photo[4], photo[5], u, v, &azPred, &elPred);

        T cosEl = cos(elTgt);
        if (cosEl < T(kMinCosEl)) cosEl = T(kMinCosEl);

        residuals[0] = WrapPi(azPred - azTgt) * cosEl;
        residuals[1] = elPred - elTgt;
        return true;
    }
};

// Tikhonov L2 regularization on one scalar within a parameter block. Adds
// a 1-residual block emitting √λ · x[idx], pulling the value toward 0. Used
// for both K1/K2 (idx 4/5 within the 6-vec photo block) and station ENU
// offsets (idx 0 against a 1-D axis block).
struct TikhonovL2Cost {
    double sqrt_lambda;
    int    idx;

    TikhonovL2Cost(double sqrt_lambda_in, int idx_in)
        : sqrt_lambda(sqrt_lambda_in), idx(idx_in) {}

    template <typename T>
    bool operator()(const T* const x, T* residual) const {
        residual[0] = T(sqrt_lambda) * x[idx];
        return true;
    }
};

}  // namespace pc

#endif  // PANORAMA_COST_FUNCTOR_H
