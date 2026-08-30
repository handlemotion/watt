use gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*, px};

use super::{
    icon::{Icon, IconName},
    text::text,
    theme,
};

#[derive(IntoElement)]
pub struct Composer;

impl RenderOnce for Composer {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        div()
            .flex()
            .flex_1()
            .w_full()
            .min_h_0()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .pb(px(60.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .w(theme::COMPOSER_WIDTH)
                    .gap(px(32.0))
                    .px(px(12.0))
                    .py(px(10.0))
                    .rounded(px(16.0))
                    .border_1()
                    .border_color(theme::border())
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .px(px(4.0))
                            .py(px(6.0))
                            .child(text(15.0, theme::text(), "Let’s get it started in here")),
                    )
                    .child(
                        div()
                            .flex()
                            .w_full()
                            .h(px(32.0))
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(agent_chip())
                                    .child(ghost_plus()),
                            )
                            .child(filled_plus()),
                    ),
            )
    }
}

fn agent_chip() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .h(px(28.0))
        .items_center()
        .justify_center()
        .px(px(8.0))
        .rounded_full()
        .border_1()
        .border_color(theme::border())
        .child(text(13.0, theme::text(), "Agent"))
}

fn ghost_plus() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .size(theme::ICON_HIT)
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(99.0))
        .child(Icon::new(IconName::Plus14))
}

fn filled_plus() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .size(theme::ICON_HIT)
        .items_center()
        .justify_center()
        .rounded(px(99.0))
        .bg(theme::plus_button())
        .overflow_hidden()
        .child(Icon::new(IconName::Plus14))
}
