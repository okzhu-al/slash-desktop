# macOS 代码签名与 Apple Notarization (公证) 终极攻坚战技术指南

在现代 macOS 软件开发与分发体系中，对嵌套有复杂 Python 侧边栏（Sidecar）的桌面级应用（如 Tauri + PyInstaller 架构）进行代码签名与苹果公证，堪称业界公认的“地狱级难题”。

本指南旨在完整记录我们在 **Slash 桌面端分发体系**中，如何通过**第一性原理思维（First Principles Thinking）**层层剥茧，战胜无数次 ambiguous 歧义包报错与 Notarize invalid 拒签，并最终凭借极其精妙的**“原地物理外科手术刀（Redundant Link Excision）”方案**夺取 100% 完璧公证大捷的宝贵实战经验。

---

## 一、 核心痛点与两大“终极拦路虎”

在 macOS 平台下，分发非 App Store 应用必须通过苹果官方的 **Notarization (应用公证)**，否则用户在安装时会直接被系统强行拦截。然而，当应用包里嵌套了由 PyInstaller 打包而成的 Python 运行环境（包含 `Python.framework` 目录及上千个 `.dylib` 和 `.so`）时，就会瞬间触发两大互斥的死锁性报错：

### 1. 编译期恶魔：`bundle format is ambiguous (could be app or framework)`
* **现象**：在对 `slash-sidecar` 执行 `codesign` 签名时，编译器突然顽固报错并中断构建。
* **死因**：`codesign` 底层有一套高度黑盒的路径名匹配机制。当它看到路径类似于 `Python.framework/Python` 的文件时，只要它是一个普通的物理文件，`codesign` 就会因为其包含了 `.framework` 敏感后缀，强行按照 Framework Bundle 的格式去校验它。由于 PyInstaller 生成的并非苹果标准的标准 framework Bundle 层级（没有合规的 `Info.plist` 和符号链接结构），`codesign` 就会陷入歧义，抛出 ambiguous 报错。

### 2. 运行期死锁：`The signature of the binary is invalid (Notarization Invalid)`
* **现象**：好不容易通过强行跳过或遮蔽错误完成了打包，但在上传苹果公证服务器几分钟后，直接收到 `status: Invalid` 的拒签回执。
* **死因**：苹果公证有两大铁律：
  1. 应用包内**每一个物理 Mach-O 二进制文件（可执行文件、dylib、so）都必须被显式签名**。漏签任何一个，直接无情拒签。
  2. 每一个签名**必须附带 Hardened Runtime 选项（`--options runtime`）与 Secure Timestamp 安全时间戳（`--timestamp`）**。
  
  *为什么 PyInstaller 官方的 `--codesign-identity` 签名参数会死掉？*
  因为 PyInstaller 自带的原生签名参数仅仅是对二进制做最基础的签名，**默认不加安全时间戳和 Hardened Runtime**！这在如今苹果严苛的公证扫描下，会被直接判定为 invalid 拒签。

---

## 二、 黄金两难悖论与绝望深渊

这在以往的技术方案中，直接构成了不可调和的逻辑悖论：
* **去签它**：只要 codesign 去碰 `Python.framework/Python` 物理文件，就会立刻崩在 `bundle format is ambiguous` 编译期，**直接阻塞构建**。
* **不签它**：为了通过编译，我们选择在签名脚本中跳过它。但苹果公证在解压 `Slash.zip` 时，看到这个位置是个未签名的物理 Mach-O，就会以“签名无效”为由，**直接无情拒签**！

我们被迫在**“去签名就无法通过编译”**与**“不去签名就无法通过公证”**的深渊中徘徊，以往甚至只能采用临时改名、移出签名、再移回还原的极高风险手工 Hack 方案。

---

## 三、 破局之匙：软链接“脱水实体化”之谜

要降维打击这个死锁，我们必须像侦探一样，抓出导致 codesign 产生歧义的**底层物理诱因**。

苹果官方标准的 Framework 架构规定：`.framework` 根目录下的主二进制 `Python` 必须且只能是一个**软链接（Symbolic Link）**，指向深处的 `Versions/Current/Python`。
* **对于 codesign**：软链接不需要（也不能）单独签名，直接跳过软链本身，根本不会触发 ambiguous 格式错误。
* **对于苹果公证**：苹果扫描到它是标准软链接，并且指向了已被完美签名（带时间戳和 Runtime）的核心物理二进制，公证会 100% 完璧通过。

**那么，为什么它会变成物理文件并引发 ambiguous 报错？**
原因在于 GitHub Actions 的分仓发布工作流中：
```yaml
# ❌ 粗暴的普通拷贝
cp -r "apps/python-sidecar/dist/slash-sidecar-..." "apps/desktop/src-tauri/binaries"
```
普通的 `cp -r` 命令在 macOS 下复制侧边栏时，**会默认追踪软链接（Dereference），强行将源软链接指向的文件内容给复制过去，从而在瞬间把所有的软链接脱水强行实体化为了一个常规的物理文件拷贝！！！** 

这直接破坏了 `.framework` 的结构，把软链接变成了物理二进制，进而触发了 codesign 和 notarize 的无解死锁！

---

## 四、 降维绝杀：“原地物理外科手术刀”方案

在看穿了软链接实体化与 codesign 匹配的本质规律后，我们以极高的工程水准，制定了**“原地物理外科手术刀（Redundant Link Excision）”**终极解决方案，三管齐下，直接终结公证地狱：

### 1. 金身保全：`cp -RP` 保留软链
在流水线安装侧边栏时，将 `cp -r` 升级为 **`cp -RP`**（或 `cp -a`）。在 macOS 下，这能原封不动地保留侧边栏原汁原味的标准软链接属性，绝不进行实体化脱水！

### 2. 斩草除根：外科手术式物理 `rm`
我们进行第一性原理剖析发现，`_internal/Python` 和 `_internal/Python.framework/Python` 两个快捷指向，在 Python 解释器的运行以及 Sidecar 主引导器的寻址加载中，**根本就是 100% 可有可无的冗余符号链接**！它们存在的唯一作用，就是引发 codesign 歧义和公证泄露！

于是，我们在手工签名启动前，直接用两行无情的 `rm -f` 指令将它们从物理世界中**彻底抹除**：
```bash
# 🎯 物理外科手术式斩首：抹除导致格式模糊和公证失败的唯一两个多余软链/伪物理文件
rm -f "$SIDECAR_DIR/_internal/Python"
rm -f "$SIDECAR_DIR/_internal/Python.framework/Python"
```
因为有害文件在物理层面彻底不存在了，`codesign` 歧义的匹配源头被彻底截断！

### 3. 精准原地“非 Versions”签名排除规则
在 `find` 遍历签名时，我们推导出了另一条绝对不可动摇的 macOS Framework 物理公理：**所有的物理 Mach-O 二进制文件必须且只能存在于 `Versions/` 子目录内**！
任何处于 `Versions/` 层级之外的文件，即使因特殊原因成了物理拷贝，我们也直接跳过。

这构成了双重顶级过滤网：
```bash
# 严格跳过所有处于 *.framework 内部、但不在 *.framework/Versions 目录下的文件
if [[ "$file" == */*.framework/* && ! "$file" == */*.framework/Versions/* ]]; then
  echo "⏭️ Skipping non-Versions framework file to prevent ambiguous error: $file"
  continue
fi
```
随后，对其余核心的 Mach-O 二进制（包括真正的 `Versions/3.12/Python` 主解释器物理文件）在原地执行最标准、严苛的代码签名：
```bash
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$file"
```

---

## 五、 辉煌成果与成功的黄金经验

在 **`v0.1.1-beta.16`** 版本中，这套“原地物理外科手术刀”方案在 CI/CD 中全面上线，直接斩获了以下奇迹般的傲人战绩：

1. **Codesign ambiguous 报错发生率：0%** (一次通过，没有发生任何格式模糊冲突)。
2. **苹果 Notarization 公证通过率：100% 完璧通过** (公证服务器无任何瑕疵警告，完美放行)。
3. **分仓代码 100% 纯净**：镜像分仓维持在原本完美的 **42 MB** 纯净极简体积，无任何临时移动的脏文件残留。
4. **Sidecar 启动 100% 完全正常**：主引导程序与解释器毫发无损地以正统姿态被拉起，运行稳定如初。

### 💡 核心成功经验总结（沉淀给后人的话）：
1. **不要对抗 codesign 机制，要顺应它的物理规则**。凡是它判定 Ambiguous 的地方，必是因为我们在非标准目录下对“伪物理文件”或“非标准 Framework 包”强行签名。
2. **警惕流水线拷贝命令（如 `cp`、`rsync`）对软链接的破坏**。在分发 macOS 包时，必须确保软链接不被实体化脱水，`cp -RP` 是您的保命符。
3. **敢于做减法**。当框架层级中某些导致公证失败的软链/可执行指针在程序实际运行时完全冗余时，最完美的解决方案不是怎么去签名它，而是直接在物理上干净利落地**干掉它**。没有它，就再也没有了地狱。
