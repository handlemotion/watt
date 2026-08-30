use gpui::{FontWeight, IntoElement, Rgba, SharedString, div, prelude::*, px};

use super::theme;

pub fn text(size: f32, color: Rgba, content: impl Into<SharedString>) -> impl IntoElement {
    let content = content.into();
    let tracking = px(size * theme::LETTER_SPACING);
    let typeface = theme::ui_font();

    div()
        .flex()
        .flex_none()
        .items_center()
        .font(typeface.clone())
        .font_weight(FontWeight::NORMAL)
        .text_color(color)
        .text_size(px(size))
        .line_height(px(size + 4.0))
        .whitespace_nowrap()
        .children(content.chars().enumerate().map(move |(index, ch)| {
            div()
                .flex_none()
                .font(typeface.clone())
                .font_weight(FontWeight::NORMAL)
                .when(index > 0, |this| this.ml(tracking))
                .child(SharedString::from(ch.to_string()))
        }))
}
