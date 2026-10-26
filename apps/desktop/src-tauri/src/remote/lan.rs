//! The short road for an offered APK when the phone is on the Mac's Wi-Fi.
//!
//! Through the relay an app travels out over the home connection to
//! Cloudflare and back, which for a game of a few hundred megabytes takes
//! many minutes. So each offer also opens a listener on the Mac's own
//! network address for as long as the offer lasts. It serves that one file,
//! only to a request carrying the offer's own key, over TLS with a
//! certificate made when ThingMaker started. The key and the certificate's
//! fingerprint reach the phone in the `install` frame, over its paired line;
//! the phone trusts that certificate and no other, then checks the file's
//! SHA-256 as it does on the relay. When the phone is elsewhere it cannot
//! reach the address and takes the relay instead.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use rustls::ServerConfig;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

/// The certificate the listeners present, and its SHA-256 for the phone.
struct Identity {
    config: Arc<ServerConfig>,
    fingerprint: String,
}

fn identity() -> Option<&'static Identity> {
    static IDENTITY: OnceLock<Option<Identity>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            let made = rcgen::generate_simple_self_signed(vec!["thingmaker.local".to_string()]).map_err(|error| tracing::warn!(%error, "no certificate for same-Wi-Fi installs")).ok()?;
            let der = made.cert.der().clone();
            let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
            let config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .and_then(|builder| builder.with_no_client_auth().with_single_cert(vec![der.clone()], key))
                .map_err(|error| tracing::warn!(%error, "no TLS for same-Wi-Fi installs"))
                .ok()?;
            let fingerprint = Sha256::digest(&der).iter().map(|byte| format!("{byte:02x}")).collect();
            Some(Identity { config: Arc::new(config), fingerprint })
        })
        .as_ref()
}

/// The Mac's address on its local network: the one its traffic leaves
/// from. Connecting a UDP socket sends nothing; it only picks the route.
fn local_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let address = socket.local_addr().ok()?.ip();
    is_local_network(address).then_some(address)
}

/// A private address a phone on the same network could reach.
fn is_local_network(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(_) => false,
    }
}

/// Where the phone can fetch offers on this network, and the certificate's
/// fingerprint; `None` when the Mac is on no local network.
pub struct Opened {
    pub base: String,
    pub cert: String,
}

/// Listens on the local network for `lasting`, serving `/v1/apk/{id}`.
pub async fn open(app: AppHandle, lasting: Duration) -> Option<Opened> {
    let identity = identity()?;
    let address = local_address()?;
    let router = Router::new().route("/v1/apk/{id}", get(super::apk::download_nearby)).with_state(app);
    let port = listen(SocketAddr::new(address, 0), router, identity, lasting).await?;
    Some(Opened { base: format!("https://{address}:{port}"), cert: identity.fingerprint.clone() })
}

/// Serves `router` over TLS at `address` until `lasting` is up; the port.
async fn listen(address: SocketAddr, router: Router, identity: &Identity, lasting: Duration) -> Option<u16> {
    let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| tracing::warn!(%error, "same-Wi-Fi install listener")).ok()?;
    let port = listener.local_addr().ok()?.port();
    let acceptor = tokio_rustls::TlsAcceptor::from(identity.config.clone());
    tauri::async_runtime::spawn(async move {
        let serving = async {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                };
                let acceptor = acceptor.clone();
                let service = hyper_util::service::TowerToHyperService::new(router.clone());
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(tls), service).await;
                });
            }
        };
        // Downloads already under way finish on their own tasks.
        tokio::select! {
            () = serving => {}
            () = tokio::time::sleep(lasting) => {}
        }
    });
    Some(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_private_address_is_offered() {
        assert!(is_local_network("192.168.1.20".parse().unwrap()));
        assert!(is_local_network("10.0.0.4".parse().unwrap()));
        assert!(is_local_network("172.20.1.1".parse().unwrap()));
        assert!(!is_local_network("81.40.12.3".parse().unwrap()));
        assert!(!is_local_network("127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn the_certificate_is_made_once_and_named_by_its_sha256() {
        let first = identity().unwrap();
        assert_eq!(first.fingerprint.len(), 64);
        assert_eq!(identity().unwrap().fingerprint, first.fingerprint);
    }
}
