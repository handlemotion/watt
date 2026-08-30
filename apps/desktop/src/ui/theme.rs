use gpui::{Pixels, Rgba, px, rgb};

pub const WINDOW_WIDTH: Pixels = px(1512.0);
pub const WINDOW_HEIGHT: Pixels = px(982.0);
pub const WINDOW_MIN_WIDTH: Pixels = px(960.0);
pub const WINDOW_MIN_HEIGHT: Pixels = px(640.0);

pub const SIDEBAR_WIDTH: Pixels = px(274.0);
pub const CHROME_HEIGHT: Pixels = px(40.0);
pub const COMPOSER_WIDTH: Pixels = px(600.0);

pub fn white() -> Rgba {
    rgb(0xffffff)
}

pub fn background() -> Rgba {
    rgb(0xffffff)
}

pub fn titlebar() -> Rgba {
    rgb(0xf5f5f3)
}

pub fn border() -> Rgba {
    rgb(0xe5e5e5)
}

pub fn text() -> Rgba {
    rgb(0x000000)
}

pub fn muted() -> Rgba {
    rgb(0x777777)
}

pub fn brand() -> Rgba {
    rgb(0x00dc33)
}

pub fn pull_request_bg() -> Rgba {
    rgb(0xd7f2cd)
}

pub fn pull_request_fg() -> Rgba {
    rgb(0x08bd32)
}

pub fn plus_button() -> Rgba {
    rgb(0xf1f1f1)
}

pub fn font_family() -> &'static str {
    ".SystemUIFont"
}
