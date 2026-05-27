FROM python:3.12-slim

WORKDIR /app

# 系统配置：替换为稳定 HTTPS 源 (Tsinghua) 并增加 APT 下载重试机制
RUN sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources || true && \
    sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources || true && \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries && \
    apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 \
    ffmpeg \
    flac \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 应用代码
COPY app/ ./app/

EXPOSE 3722

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3722"]
