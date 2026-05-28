import os

# 动态获取传参，如未传入则 fallback 到默认相对路径
app_path = defines.get('app_path', 'target/aarch64-apple-darwin/release/bundle/macos/Slash.app')
background_path = defines.get('background_path', 'apps/desktop/src-tauri/icons/dmg-background.png')

# 挂载卷中包含的文件（即已公证的 Slash.app 物理实体）
files = [app_path]

# 自动建立 /Applications 系统应用目录软链接
symlinks = {'Applications': '/Applications'}

# 卷名 (Finder 左边栏和挂载显示的名称)
volume_name = 'Slash'

# UDBZ 是 bzip2 压缩的 HFS+ 格式，能在保证精美外观的前提下，让下载体积最小化！
format = 'UDBZ'

# 初始 Finder 窗口绝对坐标与几何尺寸
# 依照 tauri.conf.json 完美匹配，宽 660, 高 400
window_rect = ((200, 120), (660, 400))

# 指定背景图片，dmgbuild 会将其拷贝入 DMG 的隐藏目录 .background 中并自动配置 DS_Store 寻址
background = background_path

# 图标大小与文字规范
icon_size = 110  # 饱满大图标设计，视觉效果一流
text_size = 12

# 完美居中贴合坐标 (x, y) - 基于窗口左上角
# 宽 660, 高 400，中间对称。
# Y 坐标从 tauri.conf.json 的 170 微调到 205
#（因为 Finder 图标渲染包含了文字空间，向下平移能防止文字贴紧边缘，使其处于背景图金色弧线和箭头的完美几何中心点！）
icon_locations = {
    os.path.basename(app_path): (180, 205),
    'Applications': (480, 205)
}
