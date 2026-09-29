//! The DevEye eye, drawn from its geometry rather than shipped as images: any
//! size stays crisp, and the working animation is the logo's own highlight
//! circling the pupil.
//!
//! Measures are those of `client/public/logo_deveye.png`, on its 512 grid. The
//! eye white is transparent in that file (it sits on white pages); here it is
//! painted, since a taskbar is often dark.

use std::f64::consts::TAU;

/// How the eye looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Look {
    /// Connected, nothing running: the logo as is.
    Idle,
    /// Working: the highlight has moved `frame` steps clockwise.
    Busy(usize),
    /// Not connected or not running: greyed out.
    Off,
}

/// Steps of one highlight turn.
pub const FRAMES: usize = 12;

const GRID: f64 = 512.0;
const CENTER: f64 = 256.0;
const R_OUTER: f64 = 256.0;
const R_WHITE: f64 = 193.0;
const R_PUPIL: f64 = 158.0;
/// The highlight's center relative to the pupil's, and its radius.
const HIGHLIGHT: (f64, f64) = (67.0, -105.0);
const R_HIGHLIGHT: f64 = 53.0;

type Rgb = [f64; 3];

const BLUE_DARK: Rgb = [42.0, 86.0, 164.0];
const BLUE_LIGHT: Rgb = [40.0, 151.0, 209.0];
const PUPIL: Rgb = [55.0, 55.0, 57.0];
const WHITE: Rgb = [255.0, 255.0, 255.0];

/// The eye at `size`×`size` pixels, as straight (not premultiplied) RGBA rows.
pub fn render(size: u32, look: Look) -> Vec<u8> {
    let turn = match look {
        Look::Busy(frame) => (frame % FRAMES) as f64 / FRAMES as f64 * TAU,
        _ => 0.0,
    };
    // Screen y points down, so a positive angle turns clockwise.
    let (sin, cos) = turn.sin_cos();
    let hx = CENTER + HIGHLIGHT.0 * cos - HIGHLIGHT.1 * sin;
    let hy = CENTER + HIGHLIGHT.0 * sin + HIGHLIGHT.1 * cos;

    // Small icons need finer sampling for their edges to stay smooth.
    let sub: u32 = if size <= 32 { 8 } else { 4 };
    let scale = GRID / size as f64;
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let mut acc = [0.0; 3];
            let mut covered = 0u32;
            for sy in 0..sub {
                for sx in 0..sub {
                    let x = (px as f64 + (sx as f64 + 0.5) / sub as f64) * scale;
                    let y = (py as f64 + (sy as f64 + 0.5) / sub as f64) * scale;
                    if let Some(c) = sample(x, y, hx, hy) {
                        covered += 1;
                        for i in 0..3 {
                            acc[i] += c[i];
                        }
                    }
                }
            }
            if covered == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            let mut rgb = acc.map(|v| v / covered as f64);
            if look == Look::Off {
                let l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
                rgb = [l; 3];
            }
            let alpha = covered as f64 / (sub * sub) as f64;
            out.extend(rgb.map(|v| v.round().clamp(0.0, 255.0) as u8));
            out.push((alpha * 255.0).round() as u8);
        }
    }
    out
}

/// The eye's color at one point of the 512 grid, `None` outside it.
fn sample(x: f64, y: f64, hx: f64, hy: f64) -> Option<Rgb> {
    let r = (x - CENTER).hypot(y - CENTER);
    if r > R_OUTER {
        return None;
    }
    if r > R_WHITE {
        // The ring darkens from the top right to the bottom left.
        let along = ((x - CENTER) - (y - CENTER)) / std::f64::consts::SQRT_2;
        let t = (along / R_OUTER + 1.0) / 2.0;
        return Some(lerp(BLUE_DARK, BLUE_LIGHT, t.clamp(0.0, 1.0)));
    }
    if (x - hx).hypot(y - hy) <= R_HIGHLIGHT {
        return Some(WHITE);
    }
    Some(if r <= R_PUPIL { PUPIL } else { WHITE })
}

fn lerp(a: Rgb, b: Rgb, t: f64) -> Rgb {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(img: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    #[test]
    fn the_eye_fills_a_disc_and_nothing_else() {
        let size = 64;
        let img = render(size, Look::Idle);
        assert_eq!(img.len(), (size * size * 4) as usize);
        assert_eq!(pixel(&img, size, 0, 0)[3], 0, "corner is transparent");
        assert_eq!(pixel(&img, size, 63, 63)[3], 0, "corner is transparent");
        assert_eq!(pixel(&img, size, 32, 32), [55, 55, 57, 255], "pupil");
        let ring = pixel(&img, size, 32, 1);
        assert!(ring[2] > ring[0] + 100, "ring is blue: {ring:?}");
    }

    #[test]
    fn the_idle_highlight_sits_top_right() {
        let size = 64;
        let img = render(size, Look::Idle);
        let (x, y) = ((323.0 / 8.0) as u32, (151.0 / 8.0) as u32);
        assert_eq!(pixel(&img, size, x, y), [255, 255, 255, 255]);
        // The opposite side of the pupil is dark.
        assert_eq!(pixel(&img, size, 64 - x, 64 - y)[0], 55);
    }

    #[test]
    fn working_moves_the_highlight_and_a_turn_comes_back() {
        let size = 32;
        assert_ne!(render(size, Look::Busy(3)), render(size, Look::Idle));
        assert_eq!(render(size, Look::Busy(0)), render(size, Look::Idle));
        assert_eq!(render(size, Look::Busy(FRAMES)), render(size, Look::Idle));
    }

    #[test]
    fn off_is_grey_with_the_same_shape() {
        let size = 32;
        let idle = render(size, Look::Idle);
        let off = render(size, Look::Off);
        for (on, off) in idle.chunks(4).zip(off.chunks(4)) {
            assert_eq!(on[3], off[3], "same coverage");
            assert!(off[0] == off[1] && off[1] == off[2], "grey: {off:?}");
        }
    }
}
