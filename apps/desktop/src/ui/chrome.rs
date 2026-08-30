use gpui::{
    App, IntoElement, Pixels, RenderOnce, SharedString, Window, WindowControlArea, div, prelude::*,
    px,
};

use super::{
    icon::{Icon, IconName},
    text::text,
    theme,
};

#[derive(IntoElement)]
pub struct Chrome;

impl RenderOnce for Chrome {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        div()
            .id("chrome")
            .flex()
            .flex_none()
            .w_full()
            .h(theme::CHROME_HEIGHT)
            .items_center()
            .justify_between()
            .overflow_hidden()
            .bg(theme::titlebar())
            .border_b_1()
            .border_color(theme::border())
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .flex()
                    .h_full()
                    .items_center()
                    .child(nav_cluster())
                    .child(tab("inactive-tab", "Add new", false))
                    .child(tab("active-tab", "Add new", true))
                    .child(plus_cluster()),
            )
            .child(trailing_cluster())
    }
}

fn nav_cluster() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .h_full()
        .items_center()
        .gap(px(8.0))
        .px(px(10.0))
        .border_r_1()
        .border_color(theme::border())
        .child(icon_hit_target("sidebar", IconName::Sidebar, px(16.0)))
        .child(icon_hit_target("back", IconName::ArrowLeft, px(16.0)))
        .child(icon_hit_target("forward", IconName::ArrowRight, px(16.0)))
}

fn tab(id: &'static str, title: &'static str, active: bool) -> impl IntoElement {
    div()
        .id(SharedString::from(id))
        .flex()
        .flex_none()
        .h_full()
        .items_center()
        .gap(px(48.0))
        .pl(px(16.0))
        .pr(px(10.0))
        .border_r_1()
        .border_color(theme::border())
        .when(active, |this| this.bg(theme::white()))
        .child(text(14.0, theme::text(), title))
        .child(icon_hit_target(
            SharedString::from(format!("{id}-close")),
            IconName::Cross,
            px(14.0),
        ))
}

fn plus_cluster() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .px(px(10.0))
        .child(icon_hit_target("new-tab", IconName::Plus14, px(14.0)))
}

fn trailing_cluster() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .h_full()
        .items_center()
        .gap(px(8.0))
        .px(px(10.0))
        .border_l_1()
        .border_color(theme::border())
        .child(icon_hit_target("console", IconName::Console, px(16.0)))
        .child(pull_request_chip())
}

fn pull_request_chip() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .h(px(26.0))
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .pl(px(7.0))
        .pr(px(8.0))
        .rounded(px(88.0))
        .bg(theme::pull_request_bg())
        .overflow_hidden()
        .child(
            Icon::new(IconName::PullRequest)
                .size(px(16.0))
                .color(theme::pull_request_fg()),
        )
        .child(text(13.0, theme::pull_request_fg(), "#112"))
}

fn icon_hit_target(
    id: impl Into<gpui::ElementId>,
    icon: IconName,
    icon_size: Pixels,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .flex_none()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(6.0))
        .child(Icon::new(icon).size(icon_size))
}
