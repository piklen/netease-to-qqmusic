#!/usr/bin/env python3
"""QQ 音乐本地执行桥接器。

由 Node 主进程通过 stdio 以 JSON Lines 驱动：每行一个命令对象，回一行结果对象。
只在本机运行，不监听端口，不向第三方服务器转发任何凭据或歌单数据。
"""

import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image
from qqmusic_api import Client, Credential
from qqmusic_api.core.transport import PreparedRequest
from qqmusic_api.models.login import QRCodeLoginEvents, QRLoginType
from qqmusic_api.modules.login_utils import QRCodeLoginSession
from qqmusic_api.modules.search import SearchType
from qqmusic_api.utils.common import hash33

PROTOCOL_VERSION = 2
SEARCH_TYPES = {0: SearchType.SONG, 8: SearchType.ALBUM, 9: SearchType.SINGER}
LOGIN_KINDS = {"1": QRLoginType.QQ, "2": QRLoginType.WX, "3": QRLoginType.MOBILE}
LOGIN_LABELS = {"1": "手机 QQ", "2": "微信", "3": "QQ 音乐 App"}


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def ok(**kwargs):
    emit({"ok": True, **kwargs})


def strip_tags(value):
    return re.sub(r"<[^>]+>", "", value or "")


def open_image(path):
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif sys.platform == "win32":
        try:
            import os
            os.startfile(str(path))  # type: ignore[attr-defined]
        except OSError:
            pass
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def credential_from_file(path):
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return Credential.model_validate(data["credential"])
    except (KeyError, ValueError):
        return None


def save_credential(path, credential):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"credential": credential.model_dump(by_alias=True)}, ensure_ascii=False))
    try:
        temp.chmod(0o600)
    except OSError:
        pass
    temp.replace(path)


def render_terminal_qr(image):
    """用半块字符绘制二维码：二维码黑色模块显示为实心块。"""
    pixels = image.convert("1")
    width, height = pixels.size
    lines = []
    for top in range(0, height, 2):
        line = []
        for left in range(width):
            # getpixel 为 0 表示黑色模块，需要点亮。
            upper = pixels.getpixel((left, top)) == 0
            lower = top + 1 < height and pixels.getpixel((left, top + 1)) == 0
            line.append("█" if upper and lower else "▀" if upper else "▄" if lower else " ")
        lines.append("".join(line))
    return "\n".join(lines)


async def login(client, path):
    credential = credential_from_file(path)
    if credential and credential.is_valid():
        client.credential = credential
        print("复用本机 QQ 音乐登录态。", flush=True)
        return

    print("QQ 音乐登录方式：1=手机 QQ，2=微信，3=QQ 音乐 App [1]：", end="", flush=True)
    answer = (sys.stdin.readline() or "").strip() or "1"
    if answer not in LOGIN_KINDS:
        raise ValueError("无效登录方式：请输入 1、2 或 3")

    session = QRCodeLoginSession(client.login, LOGIN_KINDS[answer], interval=2, timeout_seconds=300)
    qr = await session.get_qrcode()
    target = Path(path).parent
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    qr_path = Path(qr.save(str(target)))
    try:
        qr_path.chmod(0o600)
    except OSError:
        pass

    with Image.open(qr_path) as source:
        preview = source.convert("1").resize((source.width * 6, source.height * 6), Image.Resampling.NEAREST)
        preview_path = target / "qq-login-preview.png"
        preview.save(preview_path)
        try:
            preview_path.chmod(0o600)
        except OSError:
            pass
        open_image(preview_path)
        print(f"\n已打开高清二维码，请用{LOGIN_LABELS[answer]}扫码并确认：{preview_path}", flush=True)
        print(render_terminal_qr(source), flush=True)
    print("终端二维码仅作备用，优先扫描已打开的图片。", flush=True)

    async for event in session.iter_events():
        if event.event == QRCodeLoginEvents.DONE:
            if event.credential is None:
                raise RuntimeError("QQ 音乐登录结果缺少凭据")
            save_credential(path, event.credential)
            client.credential = event.credential
            qr_path.unlink(missing_ok=True)
            preview_path.unlink(missing_ok=True)
            print("QQ 音乐扫码登录成功。", flush=True)
            return
        if event.event in (QRCodeLoginEvents.REFUSE, QRCodeLoginEvents.TIMEOUT):
            raise RuntimeError(f"QQ 音乐登录未完成：{event.event}")
        print(f"QQ 音乐登录状态：{event.event}", flush=True)
    raise RuntimeError("QQ 音乐扫码登录超时")


async def search(client, command):
    kind = command.get("type", 0)
    result = await client.search.search_by_type(
        command["query"], SEARCH_TYPES[kind], num=command.get("limit", 10),
    )
    if kind == 0:
        raw = [{
            "songid": item.id, "songmid": item.mid, "songname": item.name, "type": item.type,
            "singer": [{"name": strip_tags(singer.name)} for singer in item.singer],
            "albumname": item.album.name if item.album else "",
            "interval": item.interval, "fav_show": getattr(item, "fav_show", 0),
        } for item in result.song]
    elif kind == 8:
        raw = [{
            "albumID": item.id, "albumMID": item.mid, "albumName": item.name,
            "singer_list": [{"name": strip_tags(singer.name)} for singer in item.singer_list],
        } for item in result.album]
    else:
        raw = [{
            "singerID": item.id, "singerMID": item.mid, "singerName": strip_tags(item.name),
        } for item in result.singer]
    ok(results=raw)


async def list_playlist(client, command):
    """只读列出 QQ 歌单现有歌曲，用于导入后核验。dirid 201 为“我喜欢”。"""
    request = client.songlist.get_detail(0, dirid=command["dirid"], num=100, page=1)
    await request
    songs = await request.collect_items()
    ok(songs=[{
        "id": song.id, "mid": song.mid, "name": song.name,
        "artists": [{"name": strip_tags(singer.name)} for singer in (getattr(song, "singer", None) or [])],
    } for song in songs])


async def execute(client, command):
    name = command.get("command")
    if name == "ping":
        ok(protocol=PROTOCOL_VERSION)
    elif name == "search":
        await search(client, command)
    elif name == "list_playlist":
        await list_playlist(client, command)
    elif name == "create_playlist":
        result = await client.songlist.create(command["name"])
        ok(dirid=result.dirid, name=result.name)
    elif name == "add_song":
        result = await client.songlist.add_songs(command["dirid"], [(command["songId"], command.get("songType", 1))])
        if not result:
            raise RuntimeError("QQ 音乐返回添加歌曲失败")
        ok()
    elif name == "add_song_batch":
        result = await client.songlist.add_songs(command["dirid"], [tuple(item) for item in command["songs"]])
        if not result:
            raise RuntimeError("QQ 音乐返回批量添加歌曲失败")
        ok()
    elif name == "follow_album":
        await client.album.fav_album(command["albumId"])
        ok()
    elif name == "follow_artist":
        # 库尚未封装关注歌手；沿用网页接口，失败时由 Node 侧保留断点。
        credential = client.credential
        response = await client._engine._transport.request(
            PreparedRequest(
                method="GET",
                url="https://c.y.qq.com/rsc/fcgi-bin/fcg_order_singer_add.fcg",
                kwargs={
                    "params": {"g_tk": hash33(credential.musickey, 5381), "format": "json", "singermid": command["mid"]},
                    "cookies": {"uin": credential.str_musicid or str(credential.musicid), "qqmusic_key": credential.musickey},
                    "headers": {"Referer": "https://y.qq.com/"},
                },
            )
        )
        result = response.json()
        if result.get("code") != 0:
            raise RuntimeError(f"QQ 音乐关注歌手失败：{result.get('msg') or result.get('code')}")
        ok()
    elif name == "fav_songlist":
        result = await client.user.fav_songlist(command["songlistId"])
        if not result:
            raise RuntimeError("QQ 音乐返回收藏歌单失败")
        ok()
    else:
        raise ValueError(f"未知命令：{name}")


async def main():
    options = json.loads(sys.argv[1])
    data_dir = Path(options["dataDir"])
    credential_path = data_dir / ".secrets" / "qq-credential.json"
    device_path = data_dir / ".secrets" / "qq-device.json"
    device_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    async with Client(device_path=str(device_path)) as client:
        await login(client, credential_path)
        ok(ready=True, protocol=PROTOCOL_VERSION)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                await execute(client, json.loads(line))
            except Exception as error:  # 逐命令隔离，单次失败不终止整个会话
                emit({"ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:  # 启动阶段失败（登录、依赖）需要明确告知 Node
        emit({"ok": False, "fatal": True, "error": f"{type(error).__name__}: {error}"})
        sys.exit(1)
