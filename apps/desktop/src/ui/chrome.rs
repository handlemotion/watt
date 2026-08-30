use gpui::{
    App, ClickEvent, Context, CursorStyle, ElementId, IntoElement, SharedString, Window,
    WindowControlArea, div, prelude::*, px,
};

use super::{
    icon::{Icon, IconName},
    shell::ShellView,
    text::text,
    theme,
};

pub fn chrome(shell: &ShellView, cx: &mut Context<ShellView>) -> impl IntoElement {
    let can_go_back = shell.can_go_back();
    let can_go_forward = shell.can_go_forward();
    let active_id = shell.active_id();

    div()
        .id("chrome")
        .flex()
        .flex_none()
        .w_full()
        .h(theme::CHROME_HEIGHT)
        .items_center()
        .overflow_hidden()
        .bg(theme::titlebar())
        .border_b_1()
        .border_color(theme::border())
        .child(nav_cluster(can_go_back, can_go_forward, cx))
        .child(
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .items_center()
                .child(chat_tabs(shell, active_id, cx))
                .child(plus_cluster(cx))
                .child(
                    div()
                        .id("chrome-drag")
                        .flex_1()
                        .h_full()
                        .min_w_0()
                        .window_control_area(WindowControlArea::Drag),
                ),
        )
        .child(trailing_cluster())
}

fn chat_tabs(shell: &ShellView, active_id: u64, cx: &mut Context<ShellView>) -> impl IntoElement {
    let mut tabs = div()
        .id("chat-tabs")
        .flex()
        .h_full()
        .min_w_0()
        .overflow_x_scroll();
    for chat in shell.chats() {
        tabs = tabs.child(tab(chat.id, chat.title.clone(), chat.id == active_id, cx));
    }
    tabs
}

fn nav_cluster(
    can_go_back: bool,
    can_go_forward: bool,
    cx: &mut Context<ShellView>,
) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .h_full()
        .items_center()
        .gap(px(8.0))
        .px(px(10.0))
        .border_r_1()
        .border_color(theme::border())
        .child(icon_hit_target(
            "sidebar",
            IconName::Sidebar,
            true,
            false,
            |_, _, _| {},
        ))
        .child(icon_hit_target(
            "back",
            IconName::ArrowLeft,
            can_go_back,
            false,
            cx.listener(|this, _, _, cx| {
                this.go_back();
                cx.notify();
            }),
        ))
        .child(icon_hit_target(
            "forward",
            IconName::ArrowRight,
            can_go_forward,
            false,
            cx.listener(|this, _, _, cx| {
                this.go_forward();
                cx.notify();
            }),
        ))
}

fn tab(
    id: u64,
    title: SharedString,
    active: bool,
    cx: &mut Context<ShellView>,
) -> impl IntoElement {
    div()
        .id(("chat-tab", id))
        .flex()
        .flex_none()
        .h_full()
        .items_center()
        .pl(px(16.0))
        .pr(px(10.0))
        .border_r_1()
        .border_color(theme::border())
        .cursor(CursorStyle::PointingHand)
        .when(active, |this| this.bg(theme::white()))
        .when(!active, |this| {
            this.hover(|style| style.bg(theme::control_hover()))
                .active(|style| style.bg(theme::control_pressed()))
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_chat(id);
            cx.notify();
        }))
        .child(text(14.0, theme::text(), title))
        .child(div().flex_none().w(theme::TAB_TITLE_GAP).h_full())
        .child(icon_hit_target(
            ("chat-tab-close", id),
            IconName::Cross,
            true,
            active,
            cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.close_chat(id);
                cx.notify();
            }),
        ))
}

fn plus_cluster(cx: &mut Context<ShellView>) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .px(px(10.0))
        .child(icon_hit_target(
            "new-tab",
            IconName::Plus14,
            true,
            false,
            cx.listener(|this, _, _, cx| {
                this.new_chat();
                cx.notify();
            }),
        ))
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
        .child(icon_hit_target(
            "console",
            IconName::Console,
            true,
            false,
            |_, _, _| {},
        ))
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
        .child(Icon::new(IconName::PullRequest).color(theme::pull_request_fg()))
        .child(text(13.0, theme::pull_request_fg(), "#112"))
}

fn icon_hit_target(
    id: impl Into<ElementId>,
    icon: IconName,
    enabled: bool,
    on_white: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let icon_color = if enabled {
        theme::text()
    } else {
        theme::muted()
    };
    let hover = if on_white {
        theme::control_hover_on_white()
    } else {
        theme::control_hover()
    };
    let pressed = if on_white {
        theme::control_pressed_on_white()
    } else {
        theme::control_pressed()
    };

    div()
        .id(id)
        .flex()
        .flex_none()
        .size(theme::ICON_HIT)
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(6.0))
        .map(|this| {
            if enabled {
                this.cursor(CursorStyle::PointingHand)
                    .hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(pressed))
                    .on_click(on_click)
            } else {
                this.opacity(0.4)
            }
        })
        .child(Icon::new(icon).color(icon_color))
}
