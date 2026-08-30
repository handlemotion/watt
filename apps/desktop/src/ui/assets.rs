use std::borrow::Cow;

use gpui::{AssetSource, Result, SharedString};

pub struct Assets;

const ICONS: &[(&str, &[u8])] = &[
    (
        "icons/magnifying-glass.svg",
        include_bytes!("../../assets/icons/magnifying-glass.svg"),
    ),
    (
        "icons/edit-big.svg",
        include_bytes!("../../assets/icons/edit-big.svg"),
    ),
    (
        "icons/folder-open.svg",
        include_bytes!("../../assets/icons/folder-open.svg"),
    ),
    (
        "icons/folder.svg",
        include_bytes!("../../assets/icons/folder.svg"),
    ),
    (
        "icons/sidebar.svg",
        include_bytes!("../../assets/icons/sidebar.svg"),
    ),
    (
        "icons/arrow-left.svg",
        include_bytes!("../../assets/icons/arrow-left.svg"),
    ),
    (
        "icons/arrow-right.svg",
        include_bytes!("../../assets/icons/arrow-right.svg"),
    ),
    (
        "icons/cross.svg",
        include_bytes!("../../assets/icons/cross.svg"),
    ),
    (
        "icons/plus-14.svg",
        include_bytes!("../../assets/icons/plus-14.svg"),
    ),
    (
        "icons/plus-18.svg",
        include_bytes!("../../assets/icons/plus-18.svg"),
    ),
    (
        "icons/console.svg",
        include_bytes!("../../assets/icons/console.svg"),
    ),
    (
        "icons/pull-request.svg",
        include_bytes!("../../assets/icons/pull-request.svg"),
    ),
];

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(ICONS
            .iter()
            .filter(|(name, _)| name.starts_with(path))
            .map(|(name, _)| SharedString::from(*name))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_asset_is_nonempty_svg() {
        for (name, bytes) in ICONS {
            assert!(name.ends_with(".svg"), "{name}");
            assert!(!bytes.is_empty(), "{name}");
            let text = std::str::from_utf8(bytes).expect(name);
            assert!(text.contains("<svg"), "{name}");
        }
    }
}
