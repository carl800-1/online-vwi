# 生成托盘 PNG 与打包用 ICO（零依赖：手写 PNG 的 zlib 与 CRC32）
import zlib, struct, os, sys

def png(w, h, pixel_fn, path):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        for x in range(w):
            r, g, b, a = pixel_fn(x, y, w, h)
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)
    return out

def make(w, h, path):
    # 圆角方块，深蓝底 + 白色播放三角
    r = max(2, w // 5)
    def cell(x, y, W, H):
        # 圆角判定
        cx = min(x, W - 1 - x)
        cy = min(y, H - 1 - y)
        if cx < r and cy < r:
            dx, dy = r - cx, r - cy
            if dx * dx + dy * dy > r * r:
                return (0, 0, 0, 0)
        # 播放三角：从左侧 30% 处起，向右收拢
        u = (x - W * 0.34) / (W * 0.34)      # 0..1
        v = abs(y - H / 2) / (H * 0.26)
        if 0 <= u <= 1 and v <= (1 - u):
            return (255, 255, 255, 255)
        # 底渐变
        t = y / max(1, H - 1)
        return (int(28 + 22 * t), int(96 + 40 * t), int(190 + 40 * t), 255)
    return png(w, h, cell, path)

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
assets = os.path.join(base, 'assets')
os.makedirs(assets, exist_ok=True)

small = os.path.join(assets, 'tray.png')
make(32, 32, small)
print('tray.png', os.path.getsize(small), 'bytes')

# ICO：内嵌 PNG（Vista+ 支持），单条目 256x256
big = os.path.join(assets, 'icon-256.png')
data = make(256, 256, big)
ico = os.path.join(assets, 'icon.ico')
with open(ico, 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, 1))                       # reserved, type=icon, count=1
    f.write(struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(data), 22))
    f.write(data)
print('icon.ico', os.path.getsize(ico), 'bytes')
