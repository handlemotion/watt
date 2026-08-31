pub mod bridge;
mod desktop;
#[cfg(target_os = "macos")]
mod macos;
pub mod protocol;

pub use bridge::{RunStreamItem, RunSubscription, SidecarHostClient};
pub use protocol::{BridgeError, HostEvent, ProtocolError, RunResult, StreamEndEnvelope};

pub fn run() {
    desktop::run();
}
