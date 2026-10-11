// RAW camera-file decoding. The macOS app delegates to CoreImage's CIRAWFilter;
// on Windows we decode with rawloader and run an equivalent development
// pipeline ourselves (mirrors Compositor/IO/RawImporter.swift):
// demosaic -> linearize -> white balance -> boost -> exposure -> limit ->
// sRGB gamma -> dithered 8-bit quantize.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use rawloader::RawImageData;

/// Develop settings; field names match the TS RawSettings one-to-one.
#[derive(serde::Deserialize)]
pub(crate) struct RawSettings {
    exposure: f64,    // -3..+3 EV
    temperature: f64, // 2000..12000 K
    tint: f64,        // -150..150 (negative = green, positive = magenta)
    boost: f64,       // 0..1 (0 = flat, 1 = full contrast)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawMeta {
    width: u32,
    height: u32,
    as_shot_temperature: f64,
    as_shot_tint: f64,
}

/// A decoded RAW cached in developable form: demosaiced, linearized, cropped
/// and oriented RGB at 16 bits (0..65535), plus the camera's as-shot WB.
struct CachedDecode {
    width: usize,
    height: usize,
    rgb: Vec<u16>,
    cam_wb: [f64; 3], // as-shot multipliers, green-normalized
    as_shot_kelvin: f64,
}

struct DecodeCache {
    map: HashMap<PathBuf, Arc<CachedDecode>>,
    order: Vec<PathBuf>, // insertion order, for FIFO eviction
}

static CACHE: LazyLock<Mutex<DecodeCache>> =
    LazyLock::new(|| Mutex::new(DecodeCache { map: HashMap::new(), order: Vec::new() }));

/// Kelvin (plus tint) -> RGB multipliers normalized so green == 1.
/// Tanner Helland's empirical blackbody-to-sRGB fit.
fn kelvin_rgb(kelvin: f64, tint: f64) -> [f64; 3] {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 {
        1.0
    } else {
        (1.292_936_186 * (t - 60.0).powf(-0.133_204_759_2)).clamp(0.0, 1.0)
    };
    let g = if t <= 66.0 {
        (0.390_081_578 * t.ln() - 0.631_841_444).clamp(0.0, 1.0)
    } else {
        (1.129_890_861 * (t - 60.0).powf(-0.075_514_849_2)).clamp(0.0, 1.0)
    };
    let b = if t >= 66.0 {
        1.0
    } else if t <= 19.0 {
        0.0
    } else {
        (0.543_206_789 * (t - 10.0).ln() - 1.196_254_08 * (t - 10.0)).clamp(0.0, 1.0)
    };
    let gn = if g > 1e-9 { g } else { 1.0 };
    // tint shifts the green channel against magenta
    let gm = 1.0 / (1.0 + (tint / 150.0) * 0.5);
    [r / gn, gm, b / gn]
}

/// Inverse fit: which Kelvin has the given R/B multiplier ratio? The ratio is
/// strictly decreasing over [2000 K, 12000 K], so binary-search it.
fn kelvin_from_ratio(ratio: f64) -> f64 {
    if !ratio.is_finite() || ratio <= 0.0 {
        return 5000.0;
    }
    let rb = |k: f64| {
        let m = kelvin_rgb(k, 0.0);
        m[0] / m[2]
    };
    let (lo, hi) = (2000.0, 12000.0);
    if ratio >= rb(lo) {
        return lo; // warmer than the representable range
    }
    if ratio <= rb(hi) {
        return hi; // cooler than the representable range
    }
    let (mut lo, mut hi) = (lo, hi);
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        if rb(mid) > ratio {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// "Film-like" contrast curve: a rational Reinhard-style map with f(0) = 0,
/// f(1) = 1 and a soft shoulder. `boost` blends between flat (identity)
/// and this curve, mirroring CIRAWFilter's boostAmount.
#[inline]
fn film_curve(x: f64) -> f64 {
    2.0 * x / (1.0 + x)
}

/// Linear-light value in [0, inf) -> sRGB-encoded value in [0, inf).
#[inline]
fn srgb_gamma(x: f64) -> f64 {
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// xorshift64* PRNG for the 8-bit dither; returns uniform [0, 1).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn decode_raw(path: &Path) -> Result<CachedDecode, String> {
    let raw = rawloader::decode_file(path).map_err(|e| format!("RAW decode failed: {e}"))?;

    // Active area: rawloader reports the full sensor size plus crop margins
    // (top, right, bottom, left).
    let full_w = raw.width;
    let full_h = raw.height;
    let (top, right, bottom, left) = (raw.crops[0], raw.crops[1], raw.crops[2], raw.crops[3]);
    let crop_w = left.saturating_add(right);
    let crop_h = top.saturating_add(bottom);
    let (x0, y0, w, h) = if crop_w > 0 && crop_h > 0 && full_w > crop_w && full_h > crop_h {
        (left, top, full_w - crop_w, full_h - crop_h)
    } else {
        (0, 0, full_w, full_h)
    };
    if w == 0 || h == 0 {
        return Err("RAW has no usable pixels".into());
    }

    let cpp = raw.cpp;
    if cpp != 1 && cpp < 3 {
        return Err(format!("unsupported RAW component layout (cpp = {cpp})"));
    }

    // Site color (0=R, 1=G, 2=B, 3=E) per cropped pixel, precomputed from the
    // repeating CFA pattern (2x2 for Bayer, 6x6 for X-Trans, ...). Works for
    // all Bayer variants (RGGB/BGGR/GRBG/GBRG) without case analysis.
    let pat_w = raw.cfa.width.max(1);
    let pat_h = raw.cfa.height.max(1);
    let mut pattern = vec![0u8; pat_w * pat_h];
    for i in 0..pattern.len() {
        pattern[i] = raw.cfa.color_at(i / pat_w, i % pat_w) as u8;
    }
    let site_color =
        |r: usize, c: usize| pattern[((r + y0) % pat_h) * pat_w + ((c + x0) % pat_w)];

    // Levels per color (RGBE order), with a data-scan fallback when the
    // header values are missing or degenerate.
    let mut black = [0u32; 4];
    let mut white = [0u32; 4];
    for c in 0..4 {
        black[c] = raw.blacklevels[c] as u32;
        white[c] = raw.whitelevels[c] as u32;
    }

    // Cropped samples as u16; float-encoded data (some DNGs) is normalized
    // so its maximum lands at 65535.
    let mut samples: Vec<u16> = match raw.data {
        RawImageData::Integer(ref v) => {
            if v.len() < full_w * full_h * cpp {
                return Err("RAW data shorter than expected".into());
            }
            let mut s = vec![0u16; w * h * cpp];
            for r in 0..h {
                let src = ((r + y0) * full_w + x0) * cpp;
                s[r * w * cpp..(r + 1) * w * cpp].copy_from_slice(&v[src..src + w * cpp]);
            }
            s
        }
        RawImageData::Float(ref v) => {
            if v.len() < full_w * full_h * cpp {
                return Err("RAW data shorter than expected".into());
            }
            let max = v
                .iter()
                .filter(|x| x.is_finite() && **x > 0.0)
                .copied()
                .fold(0.0f32, f32::max);
            let scale = if max > 0.0 { 65535.0 / max as f64 } else { 1.0 };
            let mut s = vec![0u16; w * h * cpp];
            for r in 0..h {
                for c in 0..w * cpp {
                    let x = v[((r + y0) * full_w + x0) * cpp + c] as f64 * scale;
                    s[r * w * cpp + c] = x.clamp(0.0, 65535.0) as u16;
                }
            }
            s
        }
    };

    let need_scan = (0..4).any(|c| white[c] <= black[c]);
    let scan_max = if need_scan {
        samples.iter().copied().fold(0u16, u16::max) as u32
    } else {
        0
    };
    for c in 0..4 {
        if white[c] <= black[c] {
            white[c] = if scan_max > black[c] { scan_max } else { 65535 };
        }
    }
    let scale = |c: usize| 65535.0 / (white[c] - black[c]) as f64;

    let mut rgb = if cpp >= 3 {
        // Already-interleaved RGB data: linearize in place, then compact.
        for r in 0..h {
            for c in 0..w {
                for ch in 0..3 {
                    let i = (r * w + c) * cpp + ch;
                    let x = (samples[i] as i64 - black[ch] as i64).max(0) as f64 * scale(ch);
                    samples[i] = (x.min(65535.0) + 0.5) as u16;
                }
            }
        }
        let mut rgb = vec![0u16; w * h * 3];
        for r in 0..h {
            for c in 0..w {
                let src = (r * w + c) * cpp;
                let dst = (r * w + c) * 3;
                rgb[dst..dst + 3].copy_from_slice(&samples[src..src + 3]);
            }
        }
        rgb
    } else {
        // CFA: linearize per site color, then bilinear-demosaic. For every
        // pixel each missing color is the average of the same-color samples
        // in its 8-neighborhood (border-clamped); the pattern itself decides
        // which neighbors those are, so all Bayer variants - and X-Trans,
        // approximately - fall out of the same rule. A single-color pattern
        // naturally degrades to grayscale.
        for i in 0..w * h {
            let c = site_color(i / w, i % w) as usize;
            let x = (samples[i] as i64 - black[c] as i64).max(0) as f64 * scale(c);
            samples[i] = (x.min(65535.0) + 0.5) as u16;
        }
        const OUT: [usize; 4] = [0, 1, 2, 1]; // emerald behaves as green
        let mut rgb = vec![0u16; w * h * 3];
        for r in 0..h {
            for c in 0..w {
                let idx = r * w + c;
                let k = OUT[site_color(r, c) as usize];
                let s = samples[idx];
                let base = idx * 3;
                rgb[base + k] = s;
                for m in 0..3 {
                    if m == k {
                        continue;
                    }
                    let (mut sum, mut n) = (0u32, 0u32);
                    for dy in -1isize..=1 {
                        for dx in -1isize..=1 {
                            if dy == 0 && dx == 0 {
                                continue;
                            }
                            let yy = r as isize + dy;
                            let xx = c as isize + dx;
                            if yy < 0 || xx < 0 || yy >= h as isize || xx >= w as isize {
                                continue;
                            }
                            let (yu, xu) = (yy as usize, xx as usize);
                            if OUT[site_color(yu, xu) as usize] == m {
                                sum += samples[yu * w + xu] as u32;
                                n += 1;
                            }
                        }
                    }
                    rgb[base + m] = if n > 0 { ((sum + n / 2) / n) as u16 } else { s };
                }
            }
        }
        rgb
    };

    // Apply the recorded orientation so portrait shots import upright.
    // to_flips() = (transpose, horizontal flip, vertical flip), with the
    // flips applied before the transpose.
    let (swap_xy, hflip, vflip) = raw.orientation.to_flips();
    let (mut width, mut height) = (w, h);
    if swap_xy || hflip || vflip {
        let stride = if swap_xy { h } else { w };
        let mut flipped = vec![0u16; w * h * 3];
        for r in 0..h {
            for c in 0..w {
                let mut ty = r;
                let mut tx = c;
                if vflip {
                    ty = h - 1 - r;
                }
                if hflip {
                    tx = w - 1 - c;
                }
                let (dst_y, dst_x) = if swap_xy { (tx, ty) } else { (ty, tx) };
                let src = (r * w + c) * 3;
                let dst = (dst_y * stride + dst_x) * 3;
                flipped[dst..dst + 3].copy_from_slice(&rgb[src..src + 3]);
            }
        }
        if swap_xy {
            width = h;
            height = w;
        }
        rgb = flipped;
    }

    // Camera as-shot white balance, green-normalized.
    let cw = raw.wb_coeffs;
    let g = if cw[1] > 0.0 {
        cw[1] as f64
    } else if cw[3] > 0.0 {
        cw[3] as f64
    } else {
        0.0
    };
    let cam_wb = if g > 0.0 && cw[0] > 0.0 && cw[2] > 0.0 {
        [cw[0] as f64 / g, 1.0, cw[2] as f64 / g]
    } else {
        [1.0, 1.0, 1.0]
    };
    let as_shot_kelvin = if cam_wb[0] > 0.0 && cam_wb[2] > 0.0 {
        kelvin_from_ratio(cam_wb[0] / cam_wb[2])
    } else {
        5000.0
    };

    Ok(CachedDecode {
        width,
        height,
        rgb,
        cam_wb,
        as_shot_kelvin,
    })
}

/// Get the (cached) decode for a path. The decode itself runs outside the
/// lock so a slow file doesn't block lookups for cached ones.
fn get_cached(path: &Path) -> Result<Arc<CachedDecode>, String> {
    {
        let cache = CACHE.lock().unwrap();
        if let Some(hit) = cache.map.get(path) {
            return Ok(hit.clone());
        }
    }
    let decoded = Arc::new(decode_raw(path)?);
    let mut cache = CACHE.lock().unwrap();
    if !cache.map.contains_key(path) {
        cache.map.insert(path.to_path_buf(), decoded.clone());
        cache.order.push(path.to_path_buf());
    }
    while cache.order.len() > 2 {
        let evict = cache.order.remove(0);
        cache.map.remove(&evict);
    }
    Ok(decoded)
}

/// Dimensions and as-shot white balance of a RAW file. rawloader has no
/// header-only API, so this performs the full decode; the result is cached
/// and the following develop_raw reuses it.
// pub(crate): the generated __cmd__ macro must be macro_export-ed for
// lib.rs's generate_handler![raw::raw_metadata] to see it.
#[tauri::command]
pub(crate) fn raw_metadata(path: String) -> Result<RawMeta, String> {
    let decoded = get_cached(&PathBuf::from(&path))?;
    Ok(RawMeta {
        width: decoded.width as u32,
        height: decoded.height as u32,
        as_shot_temperature: decoded.as_shot_kelvin,
        as_shot_tint: 0.0,
    })
}

/// Develop a RAW with the given settings. The response body is a binary
/// payload: a 24-byte header (u64 width LE, u64 height LE, u16 format
/// version = 1, u16 x3 reserved) followed by RGBA8 pixels, row-major,
/// alpha = 255. JS invoke() resolves it as an ArrayBuffer.
#[tauri::command]
pub(crate) fn develop_raw(
    path: String,
    settings: RawSettings,
    limit: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let decoded = get_cached(&PathBuf::from(&path))?;
    let exposure = settings.exposure.clamp(-3.0, 3.0);
    let temperature = settings.temperature.clamp(2000.0, 12000.0);
    let tint = settings.tint.clamp(-150.0, 150.0);
    let boost = settings.boost.clamp(0.0, 1.0);

    // White balance: the camera's as-shot multipliers, re-anchored so that
    // temperature == as-shot (tint 0) reproduces the camera rendering and
    // slider moves shift relative to it - the same semantics as
    // CIRAWFilter's neutralTemperature.
    let kr = kelvin_rgb(temperature, tint);
    let ka = kelvin_rgb(decoded.as_shot_kelvin, 0.0);
    let wb = [
        decoded.cam_wb[0] * kr[0] / ka[0],
        decoded.cam_wb[1] * kr[1] / ka[1],
        decoded.cam_wb[2] * kr[2] / ka[2],
    ];
    let ev = (2.0f64).powf(exposure);

    let (w, h) = (decoded.width, decoded.height);
    // Long-edge cap: integer box-downsample factor.
    let k = match limit {
        Some(l) if l >= 1 && w.max(h) > l as usize => w.max(h).div_ceil(l as usize),
        _ => 1,
    };
    let (ow, oh) = (w.div_ceil(k), h.div_ceil(k));

    let mut out = Vec::with_capacity(24 + ow * oh * 4);
    out.extend_from_slice(&(ow as u64).to_le_bytes());
    out.extend_from_slice(&(oh as u64).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0u8; 6]);

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for oy in 0..oh {
        for ox in 0..ow {
            // Box-average the block in the developed (pre-gamma) domain:
            // per source pixel, white balance -> boost blend -> exposure.
            let mut acc = [0.0f64; 3];
            let y_end = ((oy + 1) * k).min(h);
            let x_end = ((ox + 1) * k).min(w);
            let mut count = 0usize;
            for y in oy * k..y_end {
                for x in ox * k..x_end {
                    let base = (y * w + x) * 3;
                    for ch in 0..3 {
                        let mut v = (decoded.rgb[base + ch] as f64 / 65535.0) * wb[ch];
                        v = v * (1.0 - boost) + film_curve(v) * boost;
                        v *= ev;
                        acc[ch] += v;
                    }
                    count += 1;
                }
            }
            let inv = 1.0 / count as f64;
            for ch in 0..3 {
                // sRGB gamma, then dithered quantize: half-LSB uniform noise
                // before the floor breaks up banding (per Lightroom).
                let g = srgb_gamma(acc[ch] * inv);
                let d = rng.next() - 0.5;
                out.push((g * 255.0 + d).floor().clamp(0.0, 255.0) as u8);
            }
            out.push(255);
        }
    }
    Ok(tauri::ipc::Response::new(out))
}
