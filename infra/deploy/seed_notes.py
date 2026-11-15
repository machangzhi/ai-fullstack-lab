#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件作用：把本地 Markdown 笔记导入服务器「笔记模块」（notes_db.articles）。

用法：
    python infra/deploy/seed_notes.py
    python infra/deploy/seed_notes.py --dir docs/week2 --prefix Week2 --tags "全栈实验室,week2"

工作方式（三步）：
    1. 读取本地 docs/<week> 下的 Markdown，生成 INSERT 语句（整段内容作为 content 字段）。
    2. 通过 SFTP 把 SQL 传到服务器 /tmp，再用 mysql 客户端执行。
    3. 查询数据库核对结果，并清理远程临时文件。

为什么先 DELETE 再 INSERT：
    DELETE 只删除 tags 完全等于本次 --tags 的文章，保证脚本可重复执行（幂等），
    不会产生重复文章，也不会误删其它笔记。

前置条件：
    服务器已部署 notes-server（systemd 服务 notes-admin），且 /var/www/notes-server/.env
    里包含数据库连接信息（DB_HOST / DB_USER / DB_PASSWORD / DB_NAME）。
"""

import argparse
import os
import re
import sys

import paramiko

# ===== 服务器连接信息（与本目录下 deploy.py 保持一致）=====
HOST, PORT, USER, PASSWORD = "118.89.166.194", 22, "ubuntu", "Password1!"
NOTES_ENV = "/var/www/notes-server/.env"   # 数据库连接配置所在文件
REMOTE_TMP = "/tmp/seed_notes.sql"          # SQL 临时文件路径

# 仓库根目录（本文件位于 infra/deploy/ 下，向上两级）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(BASE_DIR, "..", ".."))


def escape_sql(text: str) -> str:
    """转义 SQL 字符串字面量。

    只处理三类在 MySQL 单引号字符串里会出问题的字符：
    - 反斜杠：必须最先替换，否则会把后面的转义字符二次转义；
    - 单引号：用 \\' 转义；
    - 换行：统一成 \\n，避免 Windows CRLF 带进数据库。
    """
    return text.replace("\\", "\\\\").replace("'", "\\'").replace("\r\n", "\n")


def make_summary(content: str, limit: int = 150) -> str:
    """从正文提取摘要：去掉 Markdown 标记符号，压缩空白，截断。

    服务器端对 summary 有 300 字符上限，这里取 150 留出余量。
    """
    text = re.sub(r"[#>*`\-_\[\]()|]", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def make_title(filename: str, prefix: str, content: str = "") -> str:
    """生成文章标题：优先用正文第一个一级标题，其次是文件名。

    这样标题能保留中文与副标题，例如：
    - "# Day 1 笔记：环境与工程初始化" → <prefix> · Day1 环境与工程初始化
    - "# 第 1 周复盘：工程基础与前后端骨架" → <prefix> · 复盘：工程基础与前后端骨架
    """
    heading = ""
    for line in content.splitlines():
        if line.startswith("# "):
            heading = line[2:].strip()
            break

    if heading:
        match = re.match(r"^day\s*(\d+)\s*笔记[：:]\s*(.+)$", heading, re.IGNORECASE)
        if match:
            return "%s · Day%s %s" % (prefix, match.group(1), match.group(2))
        match = re.match(r"^第\s*\d+\s*周复盘[：:]\s*(.+)$", heading)
        if match:
            return "%s · 复盘：%s" % (prefix, match.group(1))
        return "%s · %s" % (prefix, heading)

    stem = os.path.splitext(filename)[0]
    match = re.match(r"^day(\d+)[-_](.+)$", stem, re.IGNORECASE)
    if match:
        return "%s · Day%s %s" % (prefix, match.group(1), match.group(2))
    return "%s · %s" % (prefix, stem)


def sort_key(filename: str):
    """排序：day1..dayN 在前，其余（如 week1-复盘）排在最后。

    created_at 按顺序递增，服务器列表按时间倒序，因此复盘会显示在最上面。
    """
    match = re.match(r"^day(\d+)", filename, re.IGNORECASE)
    return (0, int(match.group(1))) if match else (1, 0)


def build_sql(docs_dir: str, prefix: str, tags: str, author: str) -> tuple:
    """生成完整 SQL，返回 (SQL 文本, 文件数)。"""
    files = sorted(
        [f for f in os.listdir(docs_dir) if f.lower().endswith(".md")],
        key=sort_key,
    )
    if not files:
        raise SystemExit("[FAIL] 目录下没有 .md 文件：%s" % docs_dir)

    lines = [
        "SET NAMES utf8mb4;",
        # 幂等：先清掉同一批标签的旧数据（只影响本脚本导入的文章）
        "DELETE FROM articles WHERE tags = '%s';" % escape_sql(tags),
    ]

    for index, filename in enumerate(files):
        with open(os.path.join(docs_dir, filename), encoding="utf-8") as handle:
            content = handle.read()

        # author_id 用子查询按用户名查，避免把 ID 写死在不同环境失效。
        lines.append(
            "INSERT INTO articles (author_id, title, summary, content, tags, status, created_at) "
            "SELECT id, '%s', '%s', '%s', '%s', 'approved', NOW() + INTERVAL %d MINUTE "
            "FROM users WHERE username = '%s';"
            % (
                escape_sql(make_title(filename, prefix, content)),
                escape_sql(make_summary(content)),
                escape_sql(content),
                escape_sql(tags),
                index,
                escape_sql(author),
            )
        )

    return "\n".join(lines) + "\n", len(files)


def run(client, command: str, timeout: int = 120) -> tuple:
    """执行远程命令，返回 (stdout, stderr)。"""
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace").strip()
    err = stderr.read().decode("utf-8", "replace").strip()
    return out, err


def main() -> int:
    parser = argparse.ArgumentParser(description="把 Markdown 笔记导入服务器笔记模块")
    parser.add_argument("--dir", default=os.path.join(PROJECT_ROOT, "docs", "week1"),
                        help="本地 Markdown 目录，默认 docs/week1")
    parser.add_argument("--prefix", default="Week1", help="标题前缀，默认 Week1")
    parser.add_argument("--tags", default="全栈实验室,week1",
                        help="文章标签（逗号分隔，同时用于幂等清理），默认 全栈实验室,week1")
    parser.add_argument("--author", default="machangzhi", help="作者用户名，默认 machangzhi")
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print("[FAIL] 目录不存在：%s" % args.dir)
        return 1

    sql, count = build_sql(args.dir, args.prefix, args.tags, args.author)
    print("[+] 生成 SQL：%d 篇，%d 字节" % (count, len(sql.encode("utf-8"))))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)
    print("[+] SSH 连接成功")

    try:
        # 上传 SQL 文件。用 SFTP 而不是拼接命令，避免引号/换行在 shell 里被破坏。
        sftp = client.open_sftp()
        with sftp.file(REMOTE_TMP, "w") as remote_file:
            remote_file.write(sql)
        sftp.close()
        print("[+] SQL 已上传 -> %s" % REMOTE_TMP)

        # set -a 让 .env 里的变量自动 export，供后续命令使用。
        out, err = run(
            client,
            "set -a; . %s; set +a; "
            'mysql -h"${DB_HOST:-127.0.0.1}" -u"$DB_USER" -p"$DB_PASSWORD" '
            '"${DB_NAME:-notes_db}" < %s' % (NOTES_ENV, REMOTE_TMP),
        )
        # mysql 的密码警告走 stderr，属于正常现象，只把真正的错误打出来。
        if err and "Using a password" not in err:
            print("[ERR] %s" % err[:400])
            return 1
        print("[OK] 导入完成")

        # 核对：查本批标签下的文章数与标题
        out, _ = run(
            client,
            "set -a; . %s; set +a; "
            'mysql -h"${DB_HOST:-127.0.0.1}" -u"$DB_USER" -p"$DB_PASSWORD" '
            "-N -e \"USE ${DB_NAME:-notes_db}; SELECT id, title FROM articles "
            "WHERE tags = '%s' ORDER BY created_at DESC;\"" % (NOTES_ENV, escape_sql(args.tags)),
        )
        print("=== 当前已发布（本批标签）===")
        print(out or "(空)")
        return 0
    finally:
        # 无论成功失败都清理远程临时文件，避免 SQL 里残留的笔记内容留在服务器上。
        run(client, "rm -f %s" % REMOTE_TMP)
        client.close()
        print("[+] SSH 已关闭")


if __name__ == "__main__":
    sys.exit(main())
