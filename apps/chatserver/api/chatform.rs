//! The one function Vercel runs (vercel.json sends every path here). Off Vercel it is a plain server on
//! CHATFORM_PORT (default 4420), for local runs and tests.

use chatserver::{Config, app, state};

#[tokio::main]
async fn main() -> Result<(), vercel_runtime::Error> {
    let config = Config::from_env();
    let st = state(config.clone()).await.map_err(|e| -> vercel_runtime::Error { e.to_string().into() })?;
    let router = app(st);
    if config.on_vercel {
        let svc = tower::ServiceBuilder::new().layer(vercel_runtime::axum::VercelLayer::new()).service(router);
        return vercel_runtime::run(svc).await;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("ChatForm server (Rust)  http://localhost:{}", config.port);
    axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;
    Ok(())
}
