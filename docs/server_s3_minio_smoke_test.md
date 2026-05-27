# Slash Server S3/MinIO Smoke Test

本文用于验证全新测试环境下的 S3/MinIO 存储链路。此流程不覆盖存量数据迁移。

## 目标

- `docker compose up` 启动 PostgreSQL、MinIO、bucket 初始化和 Slash Server。
- Server 默认使用 `STORAGE_BACKEND=s3`。
- Markdown 内容和 asset blob 都能通过 MinIO 持久化。
- 客户端慢车道上传/下载接口可用。

## 环境变量

本地测试可直接使用 compose 默认值。内测服务器建议显式创建 `.env`：

```bash
SLASH_DATA_DIR=./.docker-data
SERVER_PUBLIC_URL=http://127.0.0.1:3721
MINIO_CONSOLE_URL=http://127.0.0.1:9001
POSTGRES_PASSWORD=replace-with-a-strong-db-password
JWT_SECRET=replace-with-a-long-random-secret
MINIO_ROOT_USER=slash-minio
MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-password
S3_BUCKET=slash-storage
S3_REGION=us-east-1
STORAGE_BACKEND=s3
```

代码实际读取的 S3 变量名是：

- `STORAGE_BACKEND=s3` 或 `STORAGE_BACKEND=minio`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

`docker-compose.yml` 会在 server 容器内自动设置 `S3_ENDPOINT_URL=http://minio:9000`，并把 MinIO 账号映射到 AWS SDK 标准凭证变量。

NodeB 推荐使用固定数据目录：

```bash
SLASH_DATA_DIR=/data/slash
SERVER_PUBLIC_URL=http://<nodeb-lan-ip>:3721
MINIO_CONSOLE_URL=http://127.0.0.1:9001
```

`SERVER_PUBLIC_URL` 只是启动日志里给 Desktop 用户看的连接地址。容器内自动探测到的 `172.x.x.x` 是 Docker 内部网络地址，不适合作为 Desktop 连接地址。

这会使用以下宿主机目录：

- `/data/slash/postgres`
- `/data/slash/minio`
- `/data/slash/server-data`

启动前确保目录存在并归当前部署用户所有：

```bash
sudo mkdir -p /data/slash/{postgres,minio,server-data,backups,logs}
sudo chown -R "$USER:$USER" /data/slash
```

## 启动

```bash
docker compose up --build
```

健康检查：

```bash
curl http://127.0.0.1:3721/api/health
docker compose ps
```

MinIO Console 本机地址：

```text
http://127.0.0.1:9001
```

## 对象存储检查

查看 bucket 是否创建：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls local'
```

查看对象：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls --recursive local/"$S3_BUCKET"'
```

## 客户端功能验证

1. 启动 Desktop，连接 `http://127.0.0.1:3721`。
2. 新建一个测试 vault 或团队空间。
3. 新建一篇 Markdown 笔记并等待同步完成。
4. 在笔记里粘贴一张图片或拖入一个小文件，等待传输队列完成。
5. 用 MinIO Console 或 `mc ls --recursive` 确认 bucket 里出现 `{vault_id}/...` object。
6. 清空第二个测试客户端本地 vault 后重新连接同一 server，确认 Markdown 和 asset 都能拉取恢复。
7. 删除引用 asset 的笔记，确认同步不崩溃。
8. 重启 compose 后再次打开客户端，确认内容仍可读取。

## 当前已知限制

- 这是全新测试环境流程，不迁移旧的 LocalFileStorage 数据。
- 当前客户端上传会先读取完整本地文件再分块发送；服务端 S3 写入会先拼接临时文件再 `PutObject`。内测阶段建议先控制单文件大小，不把它当作 GB 级大文件方案。
- PostgreSQL、MinIO API 和 MinIO Console 在 compose 中仅绑定到 `127.0.0.1`；迁移到内测服务器时建议通过 Tailscale/WireGuard 或反向代理访问，不直接公网暴露这些端口。
