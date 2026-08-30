use gpui::{Context, IntoElement, Render, Window, div, prelude::*};

use super::{chrome::Chrome, composer::Composer, sidebar::Sidebar, theme};

pub struct ShellView;

impl ShellView {
    pub fn new() -> Self {
        Self
    }
}

impl Render for ShellView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .size_full()
            .overflow_hidden()
            .bg(theme::background())
            .text_color(theme::text())
            .font_family(theme::font_family())
            .child(Sidebar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(Chrome)
                    .child(Composer),
            )
    }
}
