use std::time::Duration;

use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use objc2_foundation::NSPoint;
use tauri::{Manager, WebviewWindow, WindowEvent};

/// Figma chrome row is 36px; lights sit at x=12, vertically centered.
const CHROME_HEIGHT: f64 = 36.0;
const TRAFFIC_LIGHT_X: f64 = 12.0;

pub fn install_traffic_lights(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    apply(&window);
    window.on_window_event({
        let window = window.clone();
        move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_)
                    | WindowEvent::ScaleFactorChanged { .. }
                    | WindowEvent::ThemeChanged(_)
                    | WindowEvent::Focused(_)
            ) {
                apply(&window);
            }
        }
    });
    // AppKit resets the buttons after webview layout, often without a draw.
    for delay_ms in [50_u64, 200] {
        let window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let apply_window = window.clone();
            let _ = window.run_on_main_thread(move || apply(&apply_window));
        });
    }
}

fn apply(window: &WebviewWindow) {
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    let ns_window = unsafe { &*ptr.cast::<NSWindow>() };
    unsafe {
        position(ns_window);
    }
}

unsafe fn position(window: &NSWindow) {
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);
    let Some(button_parent) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(titlebar) = (unsafe { button_parent.superview() }) else {
        return;
    };

    let window_height = window.frame().size.height;
    let mut titlebar_frame = NSView::frame(&titlebar);
    titlebar_frame.size.height = CHROME_HEIGHT;
    titlebar_frame.origin.y = window_height - CHROME_HEIGHT;
    titlebar.setFrame(titlebar_frame);

    let mut parent_frame = NSView::frame(&button_parent);
    parent_frame.origin.x = 0.0;
    parent_frame.origin.y = 0.0;
    parent_frame.size.height = CHROME_HEIGHT;
    button_parent.setFrame(parent_frame);

    let close_frame = NSView::frame(&close);
    let spacing = NSView::frame(&miniaturize).origin.x - close_frame.origin.x;
    let y = ((CHROME_HEIGHT - close_frame.size.height) / 2.0).max(0.0);

    let mut buttons = vec![close, miniaturize];
    if let Some(zoom) = zoom {
        buttons.push(zoom);
    }
    for (index, button) in buttons.into_iter().enumerate() {
        button.setFrameOrigin(NSPoint::new(TRAFFIC_LIGHT_X + index as f64 * spacing, y));
    }
}
