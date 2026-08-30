use gpui::{Context, FontWeight, IntoElement, Render, SharedString, Window, div, prelude::*};

use super::{chrome::chrome, composer::Composer, sidebar::Sidebar, theme};

#[derive(Clone)]
pub struct ChatTab {
    pub id: u64,
    pub title: SharedString,
}

pub struct ShellView {
    chats: Vec<ChatTab>,
    active_id: u64,
    next_id: u64,
}

impl ShellView {
    pub fn new() -> Self {
        Self {
            chats: vec![
                ChatTab {
                    id: 1,
                    title: "New Chat".into(),
                },
                ChatTab {
                    id: 2,
                    title: "New Chat".into(),
                },
            ],
            active_id: 2,
            next_id: 3,
        }
    }

    pub fn chats(&self) -> &[ChatTab] {
        &self.chats
    }

    pub fn active_id(&self) -> u64 {
        self.active_id
    }

    pub fn can_go_back(&self) -> bool {
        self.active_index().is_some_and(|index| index > 0)
    }

    pub fn can_go_forward(&self) -> bool {
        self.active_index()
            .is_some_and(|index| index + 1 < self.chats.len())
    }

    pub fn select_chat(&mut self, id: u64) {
        if self.chats.iter().any(|chat| chat.id == id) {
            self.active_id = id;
        }
    }

    pub fn new_chat(&mut self) {
        let id = self.next_id;
        self.next_id += 1;
        self.chats.push(ChatTab {
            id,
            title: "New Chat".into(),
        });
        self.active_id = id;
    }

    pub fn close_chat(&mut self, id: u64) {
        let Some(index) = self.chats.iter().position(|chat| chat.id == id) else {
            return;
        };
        let was_active = self.active_id == id;
        self.chats.remove(index);
        if self.chats.is_empty() {
            self.new_chat();
            return;
        }
        if was_active {
            let next = index.min(self.chats.len() - 1);
            self.active_id = self.chats[next].id;
        }
    }

    pub fn go_back(&mut self) {
        if let Some(index) = self.active_index()
            && index > 0
        {
            self.active_id = self.chats[index - 1].id;
        }
    }

    pub fn go_forward(&mut self) {
        if let Some(index) = self.active_index()
            && index + 1 < self.chats.len()
        {
            self.active_id = self.chats[index + 1].id;
        }
    }

    fn active_index(&self) -> Option<usize> {
        self.chats.iter().position(|chat| chat.id == self.active_id)
    }
}

impl Render for ShellView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .size_full()
            .overflow_hidden()
            .bg(theme::background())
            .text_color(theme::text())
            .font(theme::ui_font())
            .font_weight(FontWeight::NORMAL)
            .child(Sidebar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(chrome(self, cx))
                    .child(Composer),
            )
    }
}
