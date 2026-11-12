# -*- coding: utf-8 -*-
"""ai-fullstack-lab 部署：NestJS 后端（9527）+ Vue3 前端（子路径 /lab/）。

用法：
    python deploy.py            # 全量：上传前端与后端、装依赖、建服务、改 nginx
    python deploy.py web        # 只上传前端构建产物
    python deploy.py api        # 只上传后端并安装依赖、重启服务
    python deploy.py nginx      # 只插入 nginx 配置并重载
    python deploy.py verify     # 只做健康检查

前置：先在本地执行
    pnpm --filter @ai-lab/web build      (VITE_API_BASE_URL=/lab/api)
    pnpm --filter @ai-lab/api build
"""
import io
import os
import sys
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HOST, PORT, USER, PASSWORD = "118.89.166.194", 22, "ubuntu", "Password1!"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(BASE_DIR, "..", ".."))

WEB_DIST = os.path.join(PROJECT_ROOT, "apps", "web", "dist")
API_DIR = os.path.join(PROJECT_ROOT, "apps", "api")
API_DIST = os.path.join(API_DIR, "dist")

REMOTE_WEB = "/var/www/lab"
REMOTE_API = "/var/www/lab-api"
SUBPATH = "lab"
API_PORT = 9527
SERVICE = "lab-api"
NGINX_SITE = "/etc/nginx/sites-available/home"

# NestJS 12 是纯 ESM，CommonJS require(esm) 需要 Node >= 20.19 / 22.12。
# 服务器现有 /opt/node 是 20.18 且被 notes-admin 使用，绝不动它；
# 新项目单独装到 /opt/node22，只给 lab-api 用。
NODE_VERSION = "v22.21.1"
NODE_DOWNLOAD_DIR = "/opt/node-%s-linux-x64" % NODE_VERSION
NODE_MIRROR = "https://npmmirror.com/mirrors/node/%s/node-%s-linux-x64.tar.xz" % (
    NODE_VERSION, NODE_VERSION)
NODE_BIN = "/opt/node22/bin/node"
NODE_NPM = "/opt/node22/bin/npm"

ENV_CONTENT = "\n".join([
    "PORT=%d" % API_PORT,
    "APP_NAME=ai-fullstack-lab-api",
    "APP_ENV=production",
    "APP_VERSION=0.1.0",
    "CORS_ORIGIN=http://118.89.166.194",
    "",
])

UNIT = """[Unit]
Description=ai-fullstack-lab API
After=network.target

[Service]
Type=simple
WorkingDirectory=%s
EnvironmentFile=%s/.env
ExecStart=%s dist/main.js
Restart=always
RestartSec=3
User=ubuntu

[Install]
WantedBy=multi-user.target
""" % (REMOTE_API, REMOTE_API, NODE_BIN)

NGINX_BLOCK = """    # ===== ai-fullstack-lab 开始 =====
    location = /%(p)s {
        return 301 /%(p)s/;
    }

    # 前端静态资源（Vite base = /%(p)s/）
    # 必须用 ^~，否则会被下面的正则 location ~* \.(js|css)$ 抢先匹配，导致资源 404
    location ^~ /%(p)s/ {
        alias %(web)s/;
        try_files $uri $uri/ /%(p)s/index.html;
    }

    # 后端接口：去掉 /%(p)s 前缀后转发给 NestJS
    location /%(p)s/api/ {
        proxy_pass http://127.0.0.1:%(port)d/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Swagger 文档
    location /%(p)s/docs {
        proxy_pass http://127.0.0.1:%(port)d/docs;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
    # ===== ai-fullstack-lab 结束 =====

""" % {"p": SUBPATH, "web": REMOTE_WEB, "port": API_PORT}


def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)
    print("[+] SSH 连接成功")
    return client


def run(client, cmd, timeout=300, sudo=False):
    if sudo:
        cmd = "sudo -n bash -c %s" % repr(cmd)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace").strip()
    err = stderr.read().decode("utf-8", "replace").strip()
    code = stdout.channel.recv_exit_status()
    return code, out, err


def step(client, title, cmd, timeout=300, sudo=False):
    print("[..] %s" % title)
    code, out, err = run(client, cmd, timeout=timeout, sudo=sudo)
    if code != 0:
        print("[FAIL] %s\n%s" % (title, (out + "\n" + err)[:800]))
        sys.exit(1)
    print("[OK] %s" % title)
    return out


def upload_tree(client, local, remote, skip=("node_modules", ".git")):
    sftp = client.open_sftp()

    def ensure(path):
        parts = path.strip("/").split("/")
        cur = ""
        for part in parts:
            cur += "/" + part
            try:
                sftp.stat(cur)
            except IOError:
                sftp.mkdir(cur)

    ensure(remote)
    for root, dirs, files in os.walk(local):
        dirs[:] = [d for d in dirs if d not in skip]
        rel = os.path.relpath(root, local).replace("\\", "/")
        target = remote if rel == "." else "%s/%s" % (remote, rel)
        if rel != ".":
            ensure(target)
        for name in files:
            sftp.put(os.path.join(root, name), "%s/%s" % (target, name))
    sftp.close()


def install_node(client):
    """安装独立的 Node 22 到 /opt/node22，不影响现有的 /opt/node（notes-admin 在用）。"""
    code, out, _ = run(client, "%s -v 2>/dev/null || true" % NODE_BIN)
    if out.startswith("v22"):
        print("[*] Node 已是 %s，跳过安装" % out)
        return

    step(client, "下载 Node %s" % NODE_VERSION,
         "cd /opt && curl -fsSL %s -o node22.tar.xz" % NODE_MIRROR, timeout=900, sudo=True)
    step(client, "解压到 /opt/node22",
         "cd /opt && rm -rf node22 && tar -xf node22.tar.xz && mv %s node22 "
         "&& rm -f node22.tar.xz" % NODE_DOWNLOAD_DIR, sudo=True)
    code, out, _ = run(client, "%s -v; %s -v" % (NODE_BIN, NODE_NPM))
    print("[OK] Node/npm -> %s" % out.replace("\n", " / "))


def upload_web(client):
    if not os.path.isdir(WEB_DIST):
        print("[FAIL] 找不到 %s，请先执行 pnpm --filter @ai-lab/web build" % WEB_DIST)
        sys.exit(1)
    step(client, "重建前端目录",
         "rm -rf %s && mkdir -p %s && chown -R ubuntu:ubuntu %s"
         % (REMOTE_WEB, REMOTE_WEB, REMOTE_WEB), sudo=True)
    upload_tree(client, WEB_DIST, REMOTE_WEB)
    print("[OK] 前端已上传 -> %s" % REMOTE_WEB)


def upload_api(client):
    if not os.path.isdir(API_DIST):
        print("[FAIL] 找不到 %s，请先执行 pnpm --filter @ai-lab/api build" % API_DIST)
        sys.exit(1)
    step(client, "重建后端目录",
         "rm -rf %s && mkdir -p %s && chown -R ubuntu:ubuntu %s"
         % (REMOTE_API, REMOTE_API, REMOTE_API), sudo=True)

    # 注意：远端路径不能用 os.path.join，Windows 下会拼成反斜杠
    upload_tree(client, API_DIST, REMOTE_API + "/dist")
    sftp = client.open_sftp()
    sftp.put(os.path.join(API_DIR, "package.json"), REMOTE_API + "/package.json")
    with sftp.open(REMOTE_API + "/.env", "w") as f:
        f.write(ENV_CONTENT)
    sftp.close()
    print("[OK] 后端代码与配置已上传")

    step(client, "安装生产依赖（约 1 分钟）",
         "cd %s && %s install --omit=dev --no-audit --no-fund" % (REMOTE_API, NODE_NPM),
         timeout=900)


def install_service(client):
    sftp = client.open_sftp()
    with sftp.open("/tmp/lab-api.service", "w") as f:
        f.write(UNIT)
    sftp.close()
    step(client, "安装 systemd 服务",
         "mv /tmp/lab-api.service /etc/systemd/system/%s.service && "
         "systemctl daemon-reload && systemctl enable %s && systemctl restart %s"
         % (SERVICE, SERVICE, SERVICE), sudo=True)


def install_nginx(client):
    sftp = client.open_sftp()
    remote = "/tmp/lab-site.conf"
    with sftp.open(remote, "w") as f:
        f.write(NGINX_BLOCK)
    sftp.close()

    marker = "location /%s/" % SUBPATH
    code, conf, err = run(client, "cat %s" % NGINX_SITE, sudo=True)
    if code != 0:
        print("[FAIL] 读不到 %s：%s" % (NGINX_SITE, err[:200]))
        sys.exit(1)

    # 已有旧配置就整段替换，保证每次都以脚本里的定义为准
    start_marker = "    # ===== ai-fullstack-lab 开始 ====="
    end_marker = "    # ===== ai-fullstack-lab 结束 =====\n"
    if start_marker in conf:
        print("[*] 检测到旧配置，整段替换")
        i = conf.index(start_marker)
        j = conf.index(end_marker, i) + len(end_marker)
        conf = conf[:i] + conf[j:]

    anchor = "    location / {"
    if anchor not in conf:
        print("[FAIL] 未找到插入锚点，请手工检查 %s" % NGINX_SITE)
        sys.exit(1)

    # 用占位符做替换，避免 block 里的反斜杠与 & 被 sed 解释
    updated = conf.replace(anchor, "__LAB_BLOCK__" + anchor, 1)
    sftp = client.open_sftp()
    with sftp.open("/tmp/lab-site-new.conf", "w") as f:
        f.write(updated.replace("__LAB_BLOCK__", NGINX_BLOCK))
    sftp.close()

    bak = "/root/home.bak.%s" % os.urandom(3).hex()
    step(client, "备份并写入 nginx 配置",
         "cp %s %s && cp /tmp/lab-site-new.conf %s" % (NGINX_SITE, bak, NGINX_SITE), sudo=True)
    step(client, "nginx -t 校验", "nginx -t", sudo=True)
    step(client, "重载 nginx", "systemctl reload nginx", sudo=True)


def verify(client):
    checks = [
        ("后端直连", "curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:%d/api/health" % API_PORT),
        ("前端页面", "curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1/%s/" % SUBPATH),
        ("经 nginx 的接口", "curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1/%s/api/health" % SUBPATH),
        ("首页未受影响", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/"),
        ("笔记 API 未受影响", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health"),
    ]
    for name, cmd in checks:
        code, out, _ = run(client, cmd, sudo=True)
        print("[*] %-16s -> %s" % (name, out))

    code, out, _ = run(client, "curl -s http://127.0.0.1:%d/api/health" % API_PORT, sudo=True)
    print("[*] /api/health 内容：%s" % out[:200])


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which not in ("all", "web", "api", "nginx", "verify"):
        print("用法：python deploy.py [all|web|api|nginx|verify]")
        sys.exit(1)

    client = connect()
    try:
        if which in ("all", "api"):
            install_node(client)
        if which in ("all", "web"):
            upload_web(client)
        if which in ("all", "api"):
            upload_api(client)
            install_service(client)
        if which in ("all", "nginx"):
            install_nginx(client)
        if which in ("all", "verify"):
            verify(client)
    finally:
        client.close()
    print("\n[+] 完成")


if __name__ == "__main__":
    main()
