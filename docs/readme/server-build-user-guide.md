# Slash Server 用户部署指南

这份指南面向希望自行部署 Slash Server 的用户。部署完成后，你可以在 Slash Desktop 中连接自己的服务器，实现云同步和团队空间能力。

## 你需要准备什么

推荐准备一台长期在线的 Linux 服务器：

- 4 核 CPU 或更高
- 4 GB 内存起步，推荐 8 GB 以上
- 20 GB 可用磁盘起步；如果会同步图片、视频、附件，建议使用 SSD/NVMe
- 已安装 Docker 和 Docker Compose

Slash Server 会启动三个主要服务：

- Slash Server：Desktop 连接的同步服务
- PostgreSQL：保存用户、权限、同步状态等元数据
- MinIO：保存笔记内容和附件对象

## 1. 安装 Docker

如果你的服务器已经安装 Docker，可以跳过本节。

检查 Docker：

```bash
docker version
docker compose version
```

如果命令不存在，请先按你的系统安装 Docker 和 Docker Compose 插件。安装完成后，确认当前用户能运行 Docker：

```bash
docker ps
```

## 2. 获取 Slash Server

选择一个部署目录。下面以 `/data/slash` 为例：

```bash
sudo mkdir -p /data/slash
sudo chown -R "$USER:$USER" /data/slash
cd /data/slash
```

拉取项目代码：

```bash
git clone <slash-repository-url> slash
cd slash
```

如果你拿到的是压缩包，也可以解压到 `/data/slash/slash`，只要目录里包含 `docker-compose.yml` 即可。

## 3. 准备数据目录

创建服务器数据目录：

```bash
sudo mkdir -p /data/slash/{postgres,minio,server-data,backups,logs}
sudo chown -R "$USER:$USER" /data/slash
```

这些目录的用途：

- `/data/slash/postgres`：数据库数据
- `/data/slash/minio`：对象存储数据
- `/data/slash/server-data`：上传临时文件和服务端数据
- `/data/slash/backups`：备份文件
- `/data/slash/logs`：运维日志

## 4. 配置服务器

复制配置模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
nano .env
```

最小配置示例：

```bash
SLASH_DATA_DIR=/data/slash
SERVER_PUBLIC_URL=http://<your-server-ip>:3721
MINIO_CONSOLE_URL=http://127.0.0.1:9001

POSTGRES_PASSWORD=<random-hex-password>
JWT_SECRET=<random-hex-secret>

MINIO_ROOT_USER=slash-minio
MINIO_ROOT_PASSWORD=<random-hex-password>

S3_BUCKET=slash-storage
S3_REGION=us-east-1
STORAGE_BACKEND=s3
```

把 `<your-server-ip>` 换成你的服务器地址，例如：

```bash
SERVER_PUBLIC_URL=http://192.168.1.20:3721
```

生成随机密钥：

```bash
openssl rand -hex 32
openssl rand -hex 48
```

建议：

- `POSTGRES_PASSWORD` 使用 `openssl rand -hex 32`
- `MINIO_ROOT_PASSWORD` 使用 `openssl rand -hex 32`
- `JWT_SECRET` 使用 `openssl rand -hex 48`

不要把 `.env` 发给别人，也不要提交到 Git。

## 5. 启动 Slash Server

在项目目录执行：

```bash
docker compose up -d --build
```

查看服务状态：

```bash
docker compose ps
```

检查服务器是否正常：

```bash
curl http://127.0.0.1:3721/api/health
```

正常结果类似：

```json
{"service":"slash-server","status":"ok","version":"0.1.0"}
```

## 6. 获取配对码

查看启动日志：

```bash
docker compose logs --tail=120 server
```

找到类似内容：

```text
Desktop URL:  http://192.168.1.20:3721
Access Code:  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`Desktop URL` 是 Slash Desktop 里要填写的服务器地址。

`Access Code` 是首次连接服务器时使用的配对码。

如果只想快速查配对码：

```bash
docker compose logs server | grep -i "Access Code"
```

## 7. 在 Slash Desktop 中连接

打开 Slash Desktop：

1. 进入 Settings
2. 打开 Cloud Sync 或 Server Sync
3. 填写服务器地址，例如：

```text
http://192.168.1.20:3721
```

4. 输入日志中的 Access Code
5. 按界面提示完成首次配对

首次配对完成后，服务器会清除一次性配对码。以后新设备连接时，请按应用内提示使用 PIN 或重新生成配对码。

## 8. 查看 MinIO Console

MinIO Console 用来查看对象存储中的文件。默认只允许服务器本机访问，不直接暴露到局域网。

如果你在服务器本机操作，可以打开：

```text
http://127.0.0.1:9001
```

如果你在另一台电脑上访问，使用 SSH tunnel：

```bash
ssh -L 9001:127.0.0.1:9001 <user>@<your-server-ip>
```

然后在浏览器打开：

```text
http://127.0.0.1:9001
```

账号密码来自 `.env`：

```bash
MINIO_ROOT_USER
MINIO_ROOT_PASSWORD
```

进入后应能看到 bucket：

```text
slash-storage
```

## 9. 验证文件是否写入服务器

在 Slash Desktop 中新建一篇笔记并插入图片或视频，等待同步完成。

在服务器上查看对象：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls --recursive local/"$S3_BUCKET"'
```

你应该看到类似：

```text
<vault-id>/00_Inbox/example.md
<vault-id>/assets/example.png
```

## 10. 停止、重启和升级

停止：

```bash
docker compose down
```

重新启动：

```bash
docker compose up -d
```

升级：

```bash
git pull
docker compose up -d --build
```

升级后检查：

```bash
docker compose ps
curl http://127.0.0.1:3721/api/health
```

不要使用下面的命令，除非你明确知道它会删除数据卷：

```bash
docker compose down -v
```

## 11. 备份

建议定期备份 PostgreSQL 和 MinIO 数据。

备份 PostgreSQL：

```bash
mkdir -p /data/slash/backups
docker compose exec -T postgres pg_dump -U slash -d slash \
  | gzip > "/data/slash/backups/postgres_$(date +%Y%m%d_%H%M%S).sql.gz"
```

备份 MinIO：

```bash
tar -czf "/data/slash/backups/minio_$(date +%Y%m%d_%H%M%S).tar.gz" -C /data/slash minio
```

备份 server-data：

```bash
tar -czf "/data/slash/backups/server-data_$(date +%Y%m%d_%H%M%S).tar.gz" -C /data/slash server-data
```

清理旧备份：

```bash
find /data/slash/backups -type f -mtime +14 -delete
```

## 12. 常见问题

### Desktop 应该填写哪个地址？

填写 `.env` 里的 `SERVER_PUBLIC_URL`，例如：

```text
http://192.168.1.20:3721
```

不要填写 Docker 日志中的 `172.x.x.x` 地址，那是容器内部地址。

### 服务器启动后看不到配对码

如果服务器已经完成过首次配对，启动日志可能不会再显示 Access Code。可以在应用内使用 PIN 或重置配对码。

### Server 一直重启，提示数据库密码错误

如果你修改过 `POSTGRES_PASSWORD`，但 PostgreSQL 已经用旧密码初始化过，就会出现密码错误。

测试环境没有重要数据时，可以清空数据库目录后重新启动：

```bash
docker compose down
sudo find /data/slash/postgres -mindepth 1 -exec rm -rf {} +
docker compose up -d --build
```

如果已有重要数据，不要删除目录。请先备份，再按数据库维护流程修改用户密码。

### Server 提示 `InvalidPort`

通常是 `POSTGRES_PASSWORD` 中包含 `/`、`@`、`:`、`#` 等特殊字符。建议改用 hex 密码：

```bash
openssl rand -hex 32
```

### MinIO Console 在其他电脑打不开

这是正常的。默认只绑定服务器本机。请使用 SSH tunnel：

```bash
ssh -L 9001:127.0.0.1:9001 <user>@<your-server-ip>
```

### 如何确认对象存储不是公开的？

执行：

```bash
docker compose run --rm --entrypoint sh minio-init -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc anonymous get local/"$S3_BUCKET"'
```

期望结果是：

```text
Access permission for `local/slash-storage` is `private`
```

## 13. 部署完成检查清单

- `docker compose ps` 中 `server`、`postgres`、`minio` 都在运行
- `curl http://127.0.0.1:3721/api/health` 返回 `ok`
- server 日志中能看到 `Desktop URL`
- Slash Desktop 能连接 server
- 新建笔记后能同步
- 插入图片或视频后，MinIO 中能看到 `assets/` 对象
- 重启 `docker compose` 后文件仍然存在
- 已设置定期备份
