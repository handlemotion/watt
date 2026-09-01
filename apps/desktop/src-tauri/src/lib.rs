pub mod bridge;
mod desktop;
mod desktop_api;
#[cfg(target_os = "macos")]
mod macos;
pub mod protocol;
mod terminal;

pub use bridge::{RunStreamItem, RunSubscription, SidecarHostClient};
pub use protocol::{BridgeError, HostEvent, ProtocolError, RunResult, StreamEndEnvelope};

pub fn run() {
    desktop::run();
}
