use gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*, px};

use super::{
    icon::{IconName, icon_slot},
    text::text,
    theme,
};

#[derive(IntoElement)]
pub struct Sidebar;

impl RenderOnce for Sidebar {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(theme::SIDEBAR_WIDTH)
            .h_full()
            .overflow_hidden()
            .border_r_1()
            .border_color(theme::border())
            .bg(theme::background())
            .child(traffic_light_row())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .px(px(6.0))
                    .py(px(4.0))
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .w_full()
                            .child(org_row())
                            .child(nav_row(IconName::MagnifyingGlass, "Search"))
                            .child(nav_row(IconName::Edit, "Create")),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .w_full()
                            .child(section_label("Projects"))
                            .child(nav_row(IconName::FolderOpen, "Watt"))
                            .child(workspace_row("Harden app scaffolding"))
                            .child(nav_row(IconName::Folder, "Bisel"))
                            .child(nav_row(IconName::Folder, "Transitive")),
                    ),
            )
    }
}

fn traffic_light_row() -> impl IntoElement {
    div()
        .id("sidebar-traffic-lights")
        .w_full()
        .h(theme::CHROME_HEIGHT)
        .flex_none()
        .window_control_area(gpui::WindowControlArea::Drag)
}

fn org_row() -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .h(px(32.0))
        .w_full()
        .px(px(8.0))
        .rounded(px(8.0))
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .size(px(16.0))
                        .rounded(px(4.0))
                        .bg(theme::brand())
                        .items_center()
                        .justify_center()
                        .overflow_hidden()
                        .child(text(13.0, theme::white(), "H")),
                )
                .child(text(14.0, theme::text(), "Handlemotion")),
        )
}

fn nav_row(icon: IconName, label: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .h(px(32.0))
        .w_full()
        .px(px(7.0))
        .rounded(px(8.0))
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(icon_slot(icon))
                .child(text(14.0, theme::text(), label)),
        )
}

fn workspace_row(label: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .h(px(32.0))
        .w_full()
        .px(px(7.0))
        .rounded(px(8.0))
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().flex_none().size(theme::ICON_HIT).rounded(px(4.0)))
                .child(text(14.0, theme::text(), label)),
        )
}

fn section_label(label: &'static str) -> impl IntoElement {
    div()
        .flex()
        .h(px(32.0))
        .w_full()
        .items_center()
        .px(px(6.0))
        .child(text(13.0, theme::muted(), label))
}
