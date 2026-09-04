use axum::Router;
use multivibe_v1_edge::{EdgeConfig, EdgeState, build_router};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = EdgeConfig::from_env();
    let bind_address = format!("{}:{}", config.listen_host, config.listen_port);
    let state = EdgeState::new(config.clone()).await?;
    let router: Router = build_router(state);
    let listener = TcpListener::bind(&bind_address).await?;

    println!(
        "multivibe rust v1 edge listening on {}:{} (control_plane={})",
        config.listen_host, config.listen_port, config.node_control_plane_url
    );

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("failed to install Ctrl-C handler: {error}");
        }
    };

    #[cfg(unix)]
    {
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(error) => eprintln!("failed to install SIGTERM handler: {error}"),
            }
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;
}
