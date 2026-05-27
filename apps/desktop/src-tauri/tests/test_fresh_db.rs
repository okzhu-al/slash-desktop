use tauri_appslash_lib::core::db::manager::DbState;
use std::fs;

#[test]
fn test_fresh_db_initialization() {
    let tmp_dir = std::env::current_dir().unwrap().join("temp_test_vault_db_fresh");
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).unwrap();
    }
    fs::create_dir_all(&tmp_dir).unwrap();
    
    let db_state = DbState::default();
    let result = db_state.init(&tmp_dir);
    
    // Clean up connection before deleting directory
    db_state.close();
    
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).unwrap_or(());
    }
    
    assert!(result.is_ok(), "Database initialization failed: {:?}", result);
}

#[test]
fn test_uuid_collision_handling() {
    let tmp_dir = std::env::current_dir().unwrap().join("temp_test_vault_db_collision");
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).unwrap();
    }
    fs::create_dir_all(&tmp_dir).unwrap();

    let db_state = DbState::default();
    db_state.init(&tmp_dir).unwrap();

    {
        let conn_guard = db_state.connection.lock().unwrap();
        let conn = conn_guard.as_ref().unwrap();

        // 1. 创建 a.md 并注入一个唯一的 slash_id
        let a_path = tmp_dir.join("a.md");
        let initial_uuid = uuid::Uuid::new_v4().to_string();
        let a_content = format!("---\ntitle: A\nslash_id: {}\n---\nHello A", initial_uuid);
        fs::write(&a_path, a_content).unwrap();

        // 2. 扫描 a.md 并入库
        let res_a = tauri_appslash_lib::core::db::repository::scanner::scan_and_upsert(conn, &tmp_dir, "a.md");
        assert!(res_a.is_ok());

        // 3. 创建 b.md (模拟物理副本，继承了 a.md 的相同 slash_id)
        let b_path = tmp_dir.join("b.md");
        let b_content = format!("---\ntitle: B\nslash_id: {}\n---\nHello B", initial_uuid);
        fs::write(&b_path, b_content).unwrap();

        // 4. 扫描 b.md 并入库。因为 initial_uuid 被 a.md 持有且 a.md 存在，应当触发 collision 并重新生成
        let res_b = tauri_appslash_lib::core::db::repository::scanner::scan_and_upsert(conn, &tmp_dir, "b.md");
        assert!(res_b.is_ok());

        // 5. 校验数据库
        let slash_id_a: String = conn.query_row("SELECT slash_id FROM notes WHERE path = 'a.md'", [], |r| r.get(0)).unwrap();
        let slash_id_b: String = conn.query_row("SELECT slash_id FROM notes WHERE path = 'b.md'", [], |r| r.get(0)).unwrap();

        assert_eq!(slash_id_a, initial_uuid);
        assert_ne!(slash_id_b, initial_uuid);
        assert!(uuid::Uuid::parse_str(&slash_id_b).is_ok());

        // 6. 校验物理文件 b.md 已经被改写为新的 slash_id
        let updated_b_content = fs::read_to_string(&b_path).unwrap();
        assert!(updated_b_content.contains(&format!("slash_id: {}", slash_id_b)));
    }

    // Clean up
    db_state.close();
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).unwrap_or(());
    }
}

