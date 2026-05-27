pub mod manager;
pub mod migrations;
pub mod models;
pub mod repository;
pub mod task_scanner;

pub use manager::DbState;
pub use models::{Link, Note};
// Note: Task is accessed directly from models where needed
