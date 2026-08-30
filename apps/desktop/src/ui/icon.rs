use gpui::{App, IntoElement, Pixels, RenderOnce, Rgba, Window, prelude::*, px, svg};

use super::theme;

#[derive(Clone, Copy)]
pub enum IconName {
    MagnifyingGlass,
    Edit,
    FolderOpen,
    Folder,
    Sidebar,
    ArrowLeft,
    ArrowRight,
    Cross,
    Plus14,
    Plus18,
    Console,
    PullRequest,
}

impl IconName {
    fn path(self) -> &'static str {
        match self {
            Self::MagnifyingGlass => "icons/magnifying-glass.svg",
            Self::Edit => "icons/edit-big.svg",
            Self::FolderOpen => "icons/folder-open.svg",
            Self::Folder => "icons/folder.svg",
            Self::Sidebar => "icons/sidebar.svg",
            Self::ArrowLeft => "icons/arrow-left.svg",
            Self::ArrowRight => "icons/arrow-right.svg",
            Self::Cross => "icons/cross.svg",
            Self::Plus14 => "icons/plus-14.svg",
            Self::Plus18 => "icons/plus-18.svg",
            Self::Console => "icons/console.svg",
            Self::PullRequest => "icons/pull-request.svg",
        }
    }
}

#[derive(IntoElement)]
pub struct Icon {
    name: IconName,
    size: Pixels,
    color: Rgba,
}

impl Icon {
    pub fn new(name: IconName) -> Self {
        Self {
            name,
            size: px(18.0),
            color: theme::text(),
        }
    }

    pub fn size(mut self, size: Pixels) -> Self {
        self.size = size;
        self
    }

    pub fn color(mut self, color: Rgba) -> Self {
        self.color = color;
        self
    }
}

impl RenderOnce for Icon {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        svg()
            .flex_none()
            .size(self.size)
            .path(self.name.path())
            .text_color(self.color)
    }
}
