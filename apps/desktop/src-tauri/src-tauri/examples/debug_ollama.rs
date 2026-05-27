use ollama_rs::Ollama;

#[tokio::main]
async fn main() {
    let host = "http://localhost".to_string();
    let port = 11434;
    println!("Connecting to {}:{}", host, port);
    let ollama = Ollama::new(host, port);
    match ollama.list_local_models().await {
        Ok(models) => {
            println!("Success! Found models:");
            for model in models {
                println!("- {}", model.name);
            }
        },
        Err(e) => println!("Failed: {}", e),
    }

    let host2 = "http://127.0.0.1".to_string();
    println!("Connecting to {}:{}", host2, port);
    let ollama2 = Ollama::new(host2, port);
    match ollama2.list_local_models().await {
        Ok(models) => println!("Success with 127.0.0.1"),
        Err(e) => println!("Failed with 127.0.0.1: {}", e),
    }
}
