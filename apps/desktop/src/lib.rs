pub mod bridge;
mod desktop;
pub mod protocol;
mod ui;

pub use bridge::{RunStreamItem, RunSubscription, SidecarHostClient};
pub use protocol::{BridgeError, HostEvent, ProtocolError, RunResult, StreamEndEnvelope};

pub fn run() {
    desktop::run();
}
