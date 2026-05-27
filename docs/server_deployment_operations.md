# Slash Server 部署运维手册

本文记录 Slash Server 在内测服务器上的部署、启动、日志、备份、恢复和常见故障处理。当前推荐部署形态是：

- `slash-server`: Rust Axum 同步服务
- `postgres`: PostgreSQL 元数据数据库
- `minio`: S3 兼容对象存储
- `minio-init`: 启动时自动创建 bucket 并关闭匿名访问

## 1. 推荐服务器布局

NodeB 推荐作为主服务器：

```text
/data/slash
├── backups
├── logs
├── minio
├── postgres
├── server-data
└── slash              # git checkout 工作目录
```

目录用途：

- `/data/slash/postgres`: PostgreSQL 数据目录
- `/data/slash/minio`: MinIO 对象存储数据目录
- `/data/slash/server-data`: server 临时上传目录和本地 fallback 数据
- `/data/slash/backups`: 备份输出目录
- `/data/slash/logs`: 运维日志目录
- `/data/slash/slash`: 项目代码目录

初始化目录：

```bash
sudo mkdir -p /data/slash/{postgres,minio,server-data,backups,logs}
sudo chown -R "$USER:$USER" /data/slash
```

## 2. 环境变量

在项目目录创建 `.env`：

```bash
cd /data/slash/slash
cp .env.example .env
nano .env
```

NodeB 示例：

```bash
SLASH_DATA_DIR=/data/slash
SERVER_PUBLIC_URL=http://<nodeb-lan-ip>:3721
MINIO_CONSOLE_URL=http://127.0.0.1:9001

POSTGRES_PASSWORD=<hex-random>
JWT_SECRET=<hex-random>

MINIO_ROOT_USER=slash-minio
MINIO_ROOT_PASSWORD=<hex-random>

S3_BUCKET=slash-storage
S3_REGION=us-east-1
STORAGE_BACKEND=s3
```

生成密钥：

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD / MINIO_ROOT_PASSWORD
openssl rand -hex 48   # JWT_SECRET
```

注意：

- `POSTGRES_PASSWORD` 会被拼进 `DATABASE_URL`，建议用 hex，避免 URL 特殊字符导致连接解析失败。
- `JWT_SECRET` 正式使用后不要随意更换；更换会让现有登录 token 失效。
- `.env` 不提交到 git。

## 3. 网络暴露策略

默认 compose 端口：

```text
3721             Slash Server，给 Desktop 连接
127.0.0.1:5433   PostgreSQL，仅宿主机
127.0.0.1:9000   MinIO API，仅宿主机
127.0.0.1:9001   MinIO Console，仅宿主机
```

Desktop 连接地址使用：

```text
http://<nodeb-lan-ip>:3721
```

MinIO Console 远程查看使用 SSH tunnel：

```bash
ssh -L 9001:127.0.0.1:9001 okzhu@node-b-server
```

然后浏览器打开：

```text
http://127.0.0.1:9001
```

不要直接公网暴露：

- PostgreSQL
- MinIO API
- MinIO Console

## 4. 启动与停止

启动：

```bash
cd /data/slash/slash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
curl http://127.0.0.1:3721/api/health
```

停止：

```bash
docker compose down
```

重启 server：

```bash
docker compose restart server
```

完整重建：

```bash
docker compose up -d --build
```

## 5. 日志

查看 server 日志：

```bash
docker compose logs --tail=200 server
docker compose logs -f server
```

查配对码：

```bash
docker compose logs server | grep -i "Access Code"
```

查看 PostgreSQL 日志：

```bash
docker compose logs --tail=200 postgres
```

查看 MinIO 和 bucket 初始化日志：

```bash
docker compose logs --tail=200 minio
docker compose logs --tail=200 minio-init
```

启动 banner 中：

- `Desktop URL` 来自 `SERVER_PUBLIC_URL`
- `S3 Endpoint` 是 server 容器访问 MinIO 的内部地址，通常是 `http://minio:9000`
- `MinIO Console` 是运维提示地址，远程服务器通常通过 SSH tunnel 访问

## 6. MinIO 检查

查看 bucket：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls local'
```

查看对象：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls --recursive local/"$S3_BUCKET"'
```

确认 bucket 非公开：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc anonymous get local/"$S3_BUCKET"'
```

期望是：

```text
Access permission for `local/slash-storage` is `private`
```

## 7. 备份

备份脚本建议放到：

```text
/data/slash/backups
```

手动备份 PostgreSQL：

```bash
cd /data/slash/slash
mkdir -p /data/slash/backups
docker compose exec -T postgres pg_dump -U slash -d slash \
  | gzip > "/data/slash/backups/postgres_$(date +%Y%m%d_%H%M%S).sql.gz"
```

手动备份 MinIO 数据目录：

```bash
tar -czf "/data/slash/backups/minio_$(date +%Y%m%d_%H%M%S).tar.gz" -C /data/slash minio
```

手动备份 server-data：

```bash
tar -czf "/data/slash/backups/server-data_$(date +%Y%m%d_%H%M%S).tar.gz" -C /data/slash server-data
```

清理 14 天前备份：

```bash
find /data/slash/backups -type f -mtime +14 -delete
```

内测早期建议至少每天备份一次。后续可以用 `cron` 或 `systemd timer` 自动化，并把备份同步到 NodeA/NAS。

## 8. 恢复

恢复前先停止服务：

```bash
cd /data/slash/slash
docker compose down
```

恢复 PostgreSQL：

```bash
sudo find /data/slash/postgres -mindepth 1 -exec rm -rf {} +
docker compose up -d postgres
gunzip -c /data/slash/backups/postgres_YYYYMMDD_HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U slash -d slash
```

恢复 MinIO：

```bash
sudo find /data/slash/minio -mindepth 1 -exec rm -rf {} +
sudo tar -xzf /data/slash/backups/minio_YYYYMMDD_HHMMSS.tar.gz -C /data/slash
sudo chown -R "$USER:$USER" /data/slash/minio
```

恢复后启动全部服务：

```bash
docker compose up -d --build
curl http://127.0.0.1:3721/api/health
```

## 9. 升级

推荐流程：

```bash
cd /data/slash/slash
git pull
docker compose config >/tmp/slash-compose.yml
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3721/api/health
```

升级前建议先备份 PostgreSQL 和 MinIO。

## 10. 常见故障

### Server 一直 Restarting，提示 `InvalidPort`

通常是 `POSTGRES_PASSWORD` 含有 `/`、`@`、`:`、`#` 等 URL 特殊字符，破坏了 `DATABASE_URL`。解决：

```bash
openssl rand -hex 32
```

把 `.env` 里的 `POSTGRES_PASSWORD` 换成 hex。

### Server 提示 `password authentication failed for user "slash"`

原因通常是 PostgreSQL 数据目录已经用旧密码初始化过，后来改了 `.env`。如果是测试环境无数据：

```bash
docker compose down -v --remove-orphans
sudo find /data/slash/postgres -mindepth 1 -exec rm -rf {} +
sudo chown -R "$USER:$USER" /data/slash/postgres
docker compose up -d --build
```

如果已有重要数据，不要删除目录；应使用旧密码启动后在 PostgreSQL 内修改用户密码。

### 日志里显示 `172.x.x.x` 地址

这是 Docker 容器内部地址，Desktop 不应使用。设置：

```bash
SERVER_PUBLIC_URL=http://<nodeb-lan-ip>:3721
```

重新启动 server 后，banner 会显示正确的 `Desktop URL`。

### `docker compose config` 显示挂载到了 `.docker-data`

说明 `.env` 未设置或未读取 `SLASH_DATA_DIR=/data/slash`。检查：

```bash
cat .env | grep SLASH_DATA_DIR
docker compose config | grep -A6 -B2 '/var/lib/postgresql/data'
```

期望：

```text
source: /data/slash/postgres
```

### MinIO Console 无法从 Mac 访问

这是预期行为。Console 只绑定 NodeB 本机。使用 SSH tunnel：

```bash
ssh -L 9001:127.0.0.1:9001 okzhu@node-b-server
```

然后打开：

```text
http://127.0.0.1:9001
```

### Bucket 没有创建

检查 `minio-init`：

```bash
docker compose logs minio-init
```

手动创建/检查：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb --ignore-existing local/"$S3_BUCKET" && mc anonymous set none local/"$S3_BUCKET"'
```

## 11. 内测验收清单

- `curl http://127.0.0.1:3721/api/health` 返回 `ok`
- Desktop 能通过 `SERVER_PUBLIC_URL` 连接
- 首次配对码可在 server 日志中看到
- 新建 Markdown 后，MinIO 中出现 `{vault_id}/...md`
- 插入图片/视频后，MinIO 中出现 `{vault_id}/assets/...`
- bucket 权限是 `private`
- 重启 `docker compose` 后数据仍可读取
- 备份命令能成功生成文件
