use gpui::{IntoElement, Rgba, div, prelude::*, px};

pub fn text(size: f32, color: Rgba, content: &'static str) -> impl IntoElement {
    div()
        .flex_none()
        .text_color(color)
        .text_size(px(size))
        .line_height(px(size + 4.0))
        .whitespace_nowrap()
        .child(content)
}
